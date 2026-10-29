// Package server exposes meetings over HTTP: a small REST API, the per-meeting
// signaling WebSocket, and the built web client.
package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Robinaditya1045/open-meet/server/internal/meeting"
	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

// Config controls how the server is exposed.
type Config struct {
	// AllowedOrigins are the browser origins, besides the server's own, that may
	// call the API and open signaling sockets. Exact matches only.
	AllowedOrigins []string
	// WebDir holds the built client. Empty serves the API alone.
	WebDir string
	// TrustProxy takes the client address from X-Forwarded-For, which is only
	// honest behind a reverse proxy that sets it.
	TrustProxy bool
}

// Server routes HTTP traffic to the meeting registry.
type Server struct {
	reg      *meeting.Registry
	cfg      Config
	origins  map[string]bool
	upgrader websocket.Upgrader
	creates  *ipLimiter
	joins    *ipLimiter
}

// New creates a server for reg.
func New(reg *meeting.Registry, cfg Config) *Server {
	s := &Server{
		reg:     reg,
		cfg:     cfg,
		origins: map[string]bool{},
		creates: newIPLimiter(rate.Every(30*time.Second), 10),
		joins:   newIPLimiter(rate.Every(2*time.Second), 20),
	}
	for _, o := range cfg.AllowedOrigins {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			s.origins[o] = true
		}
	}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:  16 << 10,
		WriteBufferSize: 16 << 10,
		CheckOrigin:     s.originAllowed,
	}
	return s
}

// Handler returns the server's routes wrapped in its middleware.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/meetings", s.handleCreate)
	mux.HandleFunc("GET /api/meetings/{code}", s.handleSummary)
	mux.HandleFunc("GET /api/meetings/{code}/ws", s.handleWS)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	if s.cfg.WebDir != "" {
		mux.Handle("GET /", s.spa(s.cfg.WebDir))
	}
	return s.logRequests(s.securityHeaders(s.cors(mux)))
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !s.creates.allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "You're creating meetings too quickly. Try again in a moment.")
		return
	}
	rec, hostKey, err := s.reg.Create()
	if err != nil {
		slog.Error("create meeting", "error", err)
		writeError(w, http.StatusInternalServerError, "Could not create a meeting.")
		return
	}
	slog.Info("meeting created", "code", rec.Code)
	writeJSON(w, http.StatusCreated, map[string]any{
		"code":       rec.Code,
		"host_key":   hostKey,
		"created_at": rec.CreatedAt.UnixMilli(),
	})
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	code, ok := meeting.NormalizeCode(r.PathValue("code"))
	if !ok {
		writeError(w, http.StatusNotFound, "That isn't a valid meeting code.")
		return
	}
	summary, err := s.reg.Summary(code)
	if errors.Is(err, meeting.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Check your meeting code.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not look up that meeting.")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	code, ok := meeting.NormalizeCode(r.PathValue("code"))
	if !ok {
		writeError(w, http.StatusNotFound, "That isn't a valid meeting code.")
		return
	}
	if !s.joins.allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "Too many connection attempts.")
		return
	}
	ws, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(maxMessageSize)
	conn := newWSConn(ws)
	go conn.writePump()
	defer close(conn.readDone)

	// The first message says who this is: a name, perhaps a host key, perhaps
	// the token of a session to resume.
	_ = ws.SetReadDeadline(time.Now().Add(joinWait))
	_, raw, err := ws.ReadMessage()
	if err != nil {
		return
	}
	msgType, data, err := meeting.ParseMessage(raw)
	if err != nil || msgType != meeting.MsgJoin {
		conn.Close(meeting.CloseProtocol, "expected join")
		return
	}
	req, err := meeting.ParseJoin(data)
	if err != nil {
		conn.Close(meeting.CloseProtocol, "malformed join")
		return
	}

	sess, err := s.reg.Join(code, conn, req)
	switch {
	case errors.Is(err, meeting.ErrNotFound):
		conn.Send(meeting.DeniedMessage("not_found"))
		conn.Close(meeting.CloseNotFound, "meeting not found")
		return
	case errors.Is(err, meeting.ErrFull):
		conn.Send(meeting.DeniedMessage("full"))
		conn.Close(meeting.CloseFull, "meeting is full")
		return
	case err != nil:
		conn.Close(websocket.CloseTryAgainLater, "try again")
		return
	}

	conn.readLoop(sess)
	sess.Closed()
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "stats": s.reg.Stats()})
}

// originAllowed admits the server's own origin, plus the configured ones.
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	return s.origins[strings.TrimRight(origin, "/")]
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.origins[strings.TrimRight(origin, "/")] && strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)")
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// Hijack hands the connection to the WebSocket upgrader, which type-asserts for
// http.Hijacker rather than going through a ResponseController.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	r.status = http.StatusSwitchingProtocols
	return http.NewResponseController(r.ResponseWriter).Hijack()
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.Debug("http request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "duration", time.Since(start))
	})
}

// spa serves the built client, falling back to index.html for client-side routes
// such as /abc-defg-hij.
func (s *Server) spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := path.Clean("/" + r.URL.Path)
		if strings.HasPrefix(clean, "/api/") {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(clean))); err == nil && !info.IsDir() {
			if strings.HasPrefix(clean, "/assets/") {
				// Vite fingerprints everything under assets/.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	})
}

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			first, _, _ := strings.Cut(fwd, ",")
			return strings.TrimSpace(first)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// ipLimiter rate-limits by client address.
type ipLimiter struct {
	mu        sync.Mutex
	limit     rate.Limit
	burst     int
	entries   map[string]*ipEntry
	lastSweep time.Time
}

type ipEntry struct {
	limiter *rate.Limiter
	seen    time.Time
}

func newIPLimiter(limit rate.Limit, burst int) *ipLimiter {
	return &ipLimiter{limit: limit, burst: burst, entries: map[string]*ipEntry{}, lastSweep: time.Now()}
}

func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.lastSweep) > 10*time.Minute {
		for k, e := range l.entries {
			if now.Sub(e.seen) > 10*time.Minute {
				delete(l.entries, k)
			}
		}
		l.lastSweep = now
	}
	e := l.entries[ip]
	if e == nil {
		e = &ipEntry{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.entries[ip] = e
	}
	e.seen = now
	return e.limiter.Allow()
}
