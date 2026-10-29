package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Robinaditya1045/open-meet/server/internal/meeting"
	"github.com/gorilla/websocket"
)

type wire struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	reg := meeting.NewRegistry(meeting.NewMemoryStore(), nil, meeting.Options{})
	ts := httptest.NewServer(New(reg, Config{AllowedOrigins: []string{"http://allowed.example"}}).Handler())
	t.Cleanup(ts.Close)
	return ts
}

func createMeeting(t *testing.T, ts *httptest.Server) (string, string) {
	t.Helper()
	resp, err := http.Post(ts.URL+"/api/meetings", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create status %d", resp.StatusCode)
	}
	var body struct {
		Code    string `json:"code"`
		HostKey string `json:"host_key"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Code, body.HostKey
}

func dial(t *testing.T, ts *httptest.Server, code string, origin string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/meetings/" + code + "/ws"
	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	ws, resp, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial %s: %v (status %d)", url, err, status)
	}
	t.Cleanup(func() { ws.Close() })
	return ws
}

func sendMsg(t *testing.T, ws *websocket.Conn, msgType string, data any) {
	t.Helper()
	if err := ws.WriteJSON(map[string]any{"type": msgType, "data": data}); err != nil {
		t.Fatal(err)
	}
}

// expect reads until a message of msgType arrives.
func expect(t *testing.T, ws *websocket.Conn, msgType string) json.RawMessage {
	t.Helper()
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var m wire
		if err := ws.ReadJSON(&m); err != nil {
			t.Fatalf("waiting for %s: %v", msgType, err)
		}
		if m.Type == msgType {
			return m.Data
		}
	}
}

func TestCreateJoinAndChatOverWebSocket(t *testing.T) {
	ts := newTestServer(t)
	code, hostKey := createMeeting(t, ts)

	resp, err := http.Get(ts.URL + "/api/meetings/" + strings.ToUpper(strings.ReplaceAll(code, "-", "")))
	if err != nil {
		t.Fatal(err)
	}
	var summary meeting.Summary
	_ = json.NewDecoder(resp.Body).Decode(&summary)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || summary.Code != code || summary.ParticipantCount != 0 {
		t.Fatalf("summary %d %+v", resp.StatusCode, summary)
	}

	host := dial(t, ts, code, "")
	sendMsg(t, host, "join", map[string]string{"name": "Host", "host_key": hostKey})
	var joined struct {
		Self meeting.ParticipantInfo `json:"self"`
	}
	_ = json.Unmarshal(expect(t, host, "joined"), &joined)
	if !joined.Self.IsHost {
		t.Fatal("host key was not honoured")
	}

	guest := dial(t, ts, code, "http://allowed.example")
	sendMsg(t, guest, "join", map[string]string{"name": "Guest"})
	expect(t, guest, "joined")
	expect(t, host, "participants")

	sendMsg(t, guest, "chat", map[string]string{"text": "hi"})
	var chat meeting.ChatMessage
	_ = json.Unmarshal(expect(t, host, "chat"), &chat)
	if chat.Text != "hi" || chat.Name != "Guest" {
		t.Fatalf("chat = %+v", chat)
	}

	sendMsg(t, guest, "ping", nil)
	expect(t, guest, "pong")

	resp, _ = http.Get(ts.URL + "/api/meetings/" + code)
	_ = json.NewDecoder(resp.Body).Decode(&summary)
	resp.Body.Close()
	if summary.ParticipantCount != 2 || len(summary.Names) != 2 {
		t.Fatalf("live summary %+v", summary)
	}

	sendMsg(t, host, "end_meeting", nil)
	expect(t, guest, "ended")
	_ = guest.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = guest.ReadMessage()
	if !websocket.IsCloseError(err, meeting.CloseEnded) {
		t.Fatalf("guest close = %v, want code %d", err, meeting.CloseEnded)
	}
}

func TestUnknownMeetingIsRefusedWithReason(t *testing.T) {
	ts := newTestServer(t)
	ws := dial(t, ts, "bcd-fghj-kmn", "")
	sendMsg(t, ws, "join", map[string]string{"name": "x"})
	var denied struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(expect(t, ws, "denied"), &denied)
	if denied.Reason != "not_found" {
		t.Fatalf("denied reason %q", denied.Reason)
	}
	_, _, err := ws.ReadMessage()
	if !websocket.IsCloseError(err, meeting.CloseNotFound) {
		t.Fatalf("close = %v", err)
	}
}

func TestForeignOriginIsRejected(t *testing.T) {
	ts := newTestServer(t)
	code, _ := createMeeting(t, ts)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/meetings/" + code + "/ws"
	_, resp, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {"http://evil.example"}})
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin: err=%v resp=%v", err, resp)
	}
}

func TestFirstMessageMustBeJoin(t *testing.T) {
	ts := newTestServer(t)
	code, _ := createMeeting(t, ts)
	ws := dial(t, ts, code, "")
	sendMsg(t, ws, "chat", map[string]string{"text": "sneaky"})
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err := ws.ReadMessage()
	if !websocket.IsCloseError(err, meeting.CloseProtocol) {
		t.Fatalf("close = %v", err)
	}
}

func TestSPAFallback(t *testing.T) {
	dir := t.TempDir()
	if err := writeFile(dir+"/index.html", "<html>app</html>"); err != nil {
		t.Fatal(err)
	}
	reg := meeting.NewRegistry(meeting.NewMemoryStore(), nil, meeting.Options{})
	ts := httptest.NewServer(New(reg, Config{WebDir: dir}).Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/abc-defg-hjk")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("spa route: %d %q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	resp2, _ := http.Get(ts.URL + "/api/nope")
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown api route served the app: %d", resp2.StatusCode)
	}
}

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}
