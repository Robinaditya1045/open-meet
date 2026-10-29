package sfu

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// testNet plays the part of the signaling server: it delivers what the room sends
// to each test client, in order, on that client's own goroutine — never inline,
// since the room signals from under its locks.
type testNet struct {
	mu      sync.Mutex
	clients map[string]*testClient
}

func (n *testNet) client(id string) *testClient {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.clients[id]
}

func (n *testNet) SendDescription(peerID string, sd webrtc.SessionDescription) {
	if c := n.client(peerID); c != nil {
		c.inbox <- func() { c.onDescription(sd) }
	}
}

func (n *testNet) SendCandidate(peerID string, cand webrtc.ICECandidateInit) {
	if c := n.client(peerID); c != nil {
		c.inbox <- func() { c.onCandidate(cand) }
	}
}

func (n *testNet) SendAudioLevels(map[string]float64, string) {}

// testClient is a browser stand-in: it publishes a microphone and a camera on
// sendonly transceivers and answers whatever the SFU offers.
type testClient struct {
	t       *testing.T
	id      string
	room    *Room
	pc      *webrtc.PeerConnection
	streams map[string]string
	inbox   chan func()
	outbox  chan func()
	stop    chan struct{}

	mu            sync.Mutex
	remoteSet     bool
	pendingRemote []webrtc.ICECandidateInit
	offerSent     bool
	pendingLocal  []webrtc.ICECandidateInit
	received      map[string]int
}

func newTestClient(t *testing.T, n *testNet, room *Room, id string) *testClient {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	reg := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, reg); err != nil {
		t.Fatal(err)
	}
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(reg), webrtc.WithSettingEngine(se))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	c := &testClient{
		t: t, id: id, room: room, pc: pc,
		inbox:    make(chan func(), 64),
		outbox:   make(chan func(), 64),
		stop:     make(chan struct{}),
		received: map[string]int{},
		streams:  map[string]string{"mic-" + id: KindMic, "cam-" + id: KindCamera},
	}
	n.mu.Lock()
	n.clients[id] = c
	n.mu.Unlock()

	go c.run(c.inbox)
	go c.run(c.outbox)

	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}
		init := cand.ToJSON()
		c.mu.Lock()
		defer c.mu.Unlock()
		if !c.offerSent {
			c.pendingLocal = append(c.pendingLocal, init)
			return
		}
		c.outbox <- func() { _ = room.AddCandidate(id, init) }
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		name := track.StreamID()
		go func() {
			buf := make([]byte, 1500)
			for {
				if _, _, err := track.Read(buf); err != nil {
					return
				}
				c.mu.Lock()
				c.received[name]++
				c.mu.Unlock()
			}
		}()
	})
	t.Cleanup(func() {
		close(c.stop)
		_ = pc.Close()
	})
	return c
}

func (c *testClient) run(ch chan func()) {
	for {
		select {
		case <-c.stop:
			return
		case f := <-ch:
			f()
		}
	}
}

// publish adds a microphone and camera and makes the opening offer.
func (c *testClient) publish() {
	c.t.Helper()
	mic, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "mic-"+c.id)
	if err != nil {
		c.t.Fatal(err)
	}
	cam, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", "cam-"+c.id)
	if err != nil {
		c.t.Fatal(err)
	}
	for _, track := range []webrtc.TrackLocal{mic, cam} {
		if _, err := c.pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
			c.t.Fatal(err)
		}
	}

	offer, err := c.pc.CreateOffer(nil)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.pc.SetLocalDescription(offer); err != nil {
		c.t.Fatal(err)
	}
	sdp := c.pc.LocalDescription().SDP
	c.mu.Lock()
	c.outbox <- func() {
		if err := c.room.HandleOffer(c.id, sdp, c.streams, false); err != nil {
			c.t.Errorf("%s: HandleOffer: %v", c.id, err)
		}
	}
	c.offerSent = true
	for _, cand := range c.pendingLocal {
		cand := cand
		c.outbox <- func() { _ = c.room.AddCandidate(c.id, cand) }
	}
	c.pendingLocal = nil
	c.mu.Unlock()

	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		frame := 0
		for {
			select {
			case <-c.stop:
				return
			case <-ticker.C:
				_ = mic.WriteSample(media.Sample{Data: []byte{0xfc, 0xff, 0xfe}, Duration: 20 * time.Millisecond})
				frame++
				if frame%2 == 0 {
					// Bit 0 clear in the first byte marks a VP8 keyframe.
					_ = cam.WriteSample(media.Sample{Data: []byte{0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a}, Duration: 40 * time.Millisecond})
				}
			}
		}
	}()
}

func (c *testClient) onDescription(sd webrtc.SessionDescription) {
	if err := c.pc.SetRemoteDescription(sd); err != nil {
		c.t.Errorf("%s: apply %s: %v", c.id, sd.Type, err)
		return
	}
	c.flushRemoteCandidates()
	if sd.Type != webrtc.SDPTypeOffer {
		return
	}
	answer, err := c.pc.CreateAnswer(nil)
	if err != nil {
		c.t.Errorf("%s: create answer: %v", c.id, err)
		return
	}
	if err := c.pc.SetLocalDescription(answer); err != nil {
		c.t.Errorf("%s: apply answer: %v", c.id, err)
		return
	}
	sdp := c.pc.LocalDescription().SDP
	c.outbox <- func() {
		if err := c.room.HandleAnswer(c.id, sdp, c.streams); err != nil {
			c.t.Errorf("%s: HandleAnswer: %v", c.id, err)
		}
	}
}

func (c *testClient) onCandidate(cand webrtc.ICECandidateInit) {
	c.mu.Lock()
	if c.pc.RemoteDescription() == nil {
		c.pendingRemote = append(c.pendingRemote, cand)
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	_ = c.pc.AddICECandidate(cand)
}

func (c *testClient) flushRemoteCandidates() {
	c.mu.Lock()
	pending := c.pendingRemote
	c.pendingRemote = nil
	c.mu.Unlock()
	for _, cand := range pending {
		_ = c.pc.AddICECandidate(cand)
	}
}

func (c *testClient) count(stream string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.received[stream]
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestRoomForwardsBetweenPeersAndRecyclesTransceivers(t *testing.T) {
	if testing.Short() {
		t.Skip("opens real peer connections")
	}
	engine, err := NewEngine(Config{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	net := &testNet{clients: map[string]*testClient{}}
	room := engine.NewRoom("test", net)
	t.Cleanup(room.Close)

	alice := newTestClient(t, net, room, "alice")
	alice.publish()
	eventually(t, "alice's tracks to be published", func() bool {
		room.mu.RLock()
		defer room.mu.RUnlock()
		return room.pubs["mic.alice"] != nil && room.pubs["camera.alice"] != nil
	})

	bob := newTestClient(t, net, room, "bob")
	bob.publish()
	eventually(t, "bob to receive alice", func() bool {
		return bob.count("mic.alice") > 10 && bob.count("camera.alice") > 5
	})
	eventually(t, "alice to receive bob", func() bool {
		return alice.count("mic.bob") > 10 && alice.count("camera.bob") > 5
	})

	// A tile scrolled out of view stops costing bandwidth.
	room.SetPreferences("bob", map[string]Quality{"camera.alice": QualityOff})
	time.Sleep(300 * time.Millisecond)
	paused := bob.count("camera.alice")
	time.Sleep(500 * time.Millisecond)
	if got := bob.count("camera.alice"); got > paused+1 {
		t.Fatalf("camera kept flowing while paused: %d -> %d packets", paused, got)
	}
	room.SetPreferences("bob", map[string]Quality{"camera.alice": QualityLow})
	eventually(t, "alice's camera to resume for bob", func() bool {
		return bob.count("camera.alice") > paused+5
	})

	before := len(bob.pc.GetTransceivers())
	room.RemovePeer("alice")
	eventually(t, "alice's tracks to be gone", func() bool {
		room.mu.RLock()
		defer room.mu.RUnlock()
		return len(room.pubs) == 2
	})
	// Give the removal renegotiation time to settle so the transceivers are free.
	eventually(t, "bob's transceivers for alice to be released", func() bool {
		p := room.peer("bob")
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.free) == 2
	})

	carol := newTestClient(t, net, room, "carol")
	carol.publish()
	eventually(t, "carol to receive bob", func() bool {
		return carol.count("mic.bob") > 10 && carol.count("camera.bob") > 5
	})
	// Carol reaches bob on the m-lines alice left behind. Whether media then
	// plays is the receiving browser's business, and Pion as a receiver drops
	// the first packets of a reused receiver, so this asserts the SFU's half:
	// carol's tracks sit on alice's old transceivers, started and forwarding.
	eventually(t, "carol's tracks to be forwarded to bob", func() bool {
		p := room.peer("bob")
		p.mu.Lock()
		defer p.mu.Unlock()
		for _, name := range []string{"mic.carol", "camera.carol"} {
			sub := p.subs[name]
			if sub == nil || sub.down.forwarded.Load() < 5 {
				return false
			}
		}
		return true
	})
	if after := len(bob.pc.GetTransceivers()); after != before {
		t.Fatalf("bob's transceivers went from %d to %d; carol should have reused alice's", before, after)
	}
	remote := bob.pc.RemoteDescription().SDP
	for _, msid := range []string{"a=msid:mic.carol mic.carol", "a=msid:camera.carol camera.carol"} {
		if !strings.Contains(remote, msid) {
			t.Fatalf("bob was never offered %q", msid)
		}
	}
}

func TestPreferencesSentBeforeTheConnectionApplyToIt(t *testing.T) {
	engine, err := NewEngine(Config{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	room := engine.NewRoom("prefs", &testNet{clients: map[string]*testClient{}})
	t.Cleanup(room.Close)

	room.SetPreferences("viewer", map[string]Quality{"camera.other": QualityHigh})
	room.mu.Lock()
	peer, err := room.newPeer("viewer")
	room.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	defer peer.close()
	if got := peer.prefs["camera.other"]; got != QualityHigh {
		t.Fatalf("early preference lost: got %v", got)
	}
}
