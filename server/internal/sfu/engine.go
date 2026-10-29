package sfu

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// Payload types the SFU negotiates. Every publisher and every subscriber uses the
// same two codecs, which is what lets a forwarded packet go out unchanged apart
// from its sequencing: there is never a codec to translate between.
const (
	payloadTypeOpus = 111
	payloadTypeVP8  = 96
)

// Config describes how the SFU is reachable from browsers.
type Config struct {
	// UDPPort is the single UDP port every peer connection shares. One port is
	// one firewall rule, however many people are in calls. Zero falls back to an
	// ephemeral port per connection, which is only sensible in tests.
	UDPPort int
	// TCPPort accepts ICE over TCP for networks that block UDP outright
	// (corporate proxies, some hotel Wi-Fi). Zero disables it.
	TCPPort int
	// PublicIPs replace the addresses of gathered host candidates. A cloud VM
	// behind 1:1 NAT only ever sees its private address, which no browser can
	// route to; leave empty when the host is directly addressable.
	PublicIPs []string
	// IPv6 also gathers IPv6 candidates.
	IPv6 bool
	// ExcludeInterfaces lists interface name prefixes never offered as
	// candidates, such as container bridges no browser can reach.
	ExcludeInterfaces []string
	// IncludeLoopback also offers 127.0.0.1, for a browser on the same machine
	// with no other network, and for tests.
	IncludeLoopback bool
}

// Engine is the process-wide WebRTC configuration every room shares: codecs,
// interceptors, and the muxed sockets all media flows through.
type Engine struct {
	api     *webrtc.API
	closers []io.Closer
}

// NewEngine builds the WebRTC API and binds its sockets.
func NewEngine(cfg Config) (*Engine, error) {
	mediaEngine, err := newMediaEngine()
	if err != nil {
		return nil, err
	}

	// Building an API by hand opts out of every default, so NACK, RTCP reports,
	// the simulcast header extensions and transport-wide congestion feedback all
	// have to be asked for. Without TWCC feedback a publishing browser cannot
	// estimate its uplink and never turns its higher simulcast layers on.
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, fmt.Errorf("register interceptors: %w", err)
	}

	keep := interfaceFilter(cfg.ExcludeInterfaces)
	networks := []webrtc.NetworkType{webrtc.NetworkTypeUDP4}
	iceNetworks := []ice.NetworkType{ice.NetworkTypeUDP4}
	if cfg.IPv6 {
		networks = append(networks, webrtc.NetworkTypeUDP6)
		iceNetworks = append(iceNetworks, ice.NetworkTypeUDP6)
	}

	settings := webrtc.SettingEngine{}
	settings.SetInterfaceFilter(keep)
	settings.SetIncludeLoopbackCandidate(cfg.IncludeLoopback)
	// The server only ever listens; it has no reason to dial out over TCP.
	settings.DisableActiveTCP(true)

	engine := &Engine{}
	if cfg.UDPPort > 0 {
		opts := []ice.UDPMuxFromPortOption{
			ice.UDPMuxFromPortWithInterfaceFilter(keep),
			ice.UDPMuxFromPortWithNetworks(iceNetworks...),
		}
		if cfg.IncludeLoopback {
			opts = append(opts, ice.UDPMuxFromPortWithLoopback())
		}
		udpMux, err := ice.NewMultiUDPMuxFromPort(cfg.UDPPort, opts...)
		if err != nil {
			return nil, fmt.Errorf("bind rtc udp port %d: %w", cfg.UDPPort, err)
		}
		settings.SetICEUDPMux(udpMux)
		engine.closers = append(engine.closers, udpMux)
	}
	if cfg.TCPPort > 0 {
		listener, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.TCPPort))
		if err != nil {
			engine.Close()
			return nil, fmt.Errorf("bind rtc tcp port %d: %w", cfg.TCPPort, err)
		}
		tcpMux := webrtc.NewICETCPMux(nil, listener, 8)
		settings.SetICETCPMux(tcpMux)
		engine.closers = append(engine.closers, tcpMux)
		networks = append(networks, webrtc.NetworkTypeTCP4)
		if cfg.IPv6 {
			networks = append(networks, webrtc.NetworkTypeTCP6)
		}
	}
	settings.SetNetworkTypes(networks)

	if len(cfg.PublicIPs) > 0 {
		if err := settings.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        cfg.PublicIPs,
			AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode:            webrtc.ICEAddressRewriteReplace,
		}); err != nil {
			engine.Close()
			return nil, fmt.Errorf("configure public ip: %w", err)
		}
	}

	engine.api = webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings),
	)
	slog.Info("sfu engine ready", "udp_port", cfg.UDPPort, "tcp_port", cfg.TCPPort, "public_ips", cfg.PublicIPs)
	return engine, nil
}

// newMediaEngine registers Opus and VP8 only.
//
// One codec per kind is deliberate. A simulcast layer switch splices two encodings
// of the same picture into one stream, which only works if they share a codec, and
// picture-ID rewriting is codec specific. VP8 is the one every browser can both
// encode in simulcast and decode. RTX is left out too: retransmissions then come
// back on the media SSRC itself, where the forwarder already knows how to place them.
func newMediaEngine() (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}
	videoFeedback := []webrtc.RTCPFeedback{
		{Type: "ccm", Parameter: "fir"},
		{Type: "nack"},
		{Type: "nack", Parameter: "pli"},
		{Type: "transport-cc"},
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "transport-cc"},
			},
		},
		PayloadType: payloadTypeOpus,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register opus: %w", err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:     webrtc.MimeTypeVP8,
			ClockRate:    90000,
			RTCPFeedback: videoFeedback,
		},
		PayloadType: payloadTypeVP8,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register vp8: %w", err)
	}
	// The browser stamps every microphone packet with its level, which is how the
	// SFU knows who is talking without decoding a single frame of audio.
	if err := m.RegisterHeaderExtension(
		webrtc.RTPHeaderExtensionCapability{URI: sdp.AudioLevelURI},
		webrtc.RTPCodecTypeAudio,
	); err != nil {
		return nil, fmt.Errorf("register audio level extension: %w", err)
	}
	return m, nil
}

// interfaceFilter keeps every interface except those whose name starts with one of
// the excluded prefixes.
func interfaceFilter(excluded []string) func(string) bool {
	return func(name string) bool {
		for _, prefix := range excluded {
			if prefix != "" && strings.HasPrefix(name, prefix) {
				return false
			}
		}
		return true
	}
}

func (e *Engine) newPeerConnection() (*webrtc.PeerConnection, error) {
	// No ICE servers: the SFU is the addressable end of every connection, and a
	// browser reaching it is enough for the SFU to learn the browser's address.
	return e.api.NewPeerConnection(webrtc.Configuration{
		BundlePolicy:  webrtc.BundlePolicyMaxBundle,
		RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire,
	})
}

// Close releases the shared sockets. Rooms must be closed first.
func (e *Engine) Close() error {
	var errs []error
	for _, c := range e.closers {
		if err := c.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	e.closers = nil
	return errors.Join(errs...)
}
