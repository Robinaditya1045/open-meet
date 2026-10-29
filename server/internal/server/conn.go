package server

import (
	"log/slog"
	"sync"
	"time"

	"github.com/Robinaditya1045/open-meet/server/internal/meeting"
	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 45 * time.Second
	pingPeriod = 20 * time.Second
	// joinWait bounds how long a connection may sit without saying who it is.
	joinWait = 10 * time.Second
	// maxMessageSize fits an SDP for a call with a few dozen participants, each
	// a few m-lines.
	maxMessageSize = 512 << 10
	sendBuffer     = 256
)

type closeRequest struct {
	code   int
	reason string
}

// wsConn is a meeting.Conn over a WebSocket. Writes happen on one goroutine;
// Send only queues, so a meeting broadcasting to a stalled client never waits
// on it.
type wsConn struct {
	ws       *websocket.Conn
	send     chan []byte
	closing  chan closeRequest
	done     chan struct{}
	readDone chan struct{}

	closeOnce sync.Once
	doneOnce  sync.Once
}

func newWSConn(ws *websocket.Conn) *wsConn {
	return &wsConn{
		ws:       ws,
		send:     make(chan []byte, sendBuffer),
		closing:  make(chan closeRequest, 1),
		done:     make(chan struct{}),
		readDone: make(chan struct{}),
	}
}

// Send queues a message. A client whose queue is full is too far behind to
// catch up, and is disconnected so it can reconnect and resync.
func (c *wsConn) Send(msg []byte) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.send <- msg:
		return true
	default:
		slog.Warn("disconnecting client that cannot keep up")
		c.Close(websocket.CloseTryAgainLater, "too far behind")
		return false
	}
}

// Close flushes what is queued, then closes with code.
func (c *wsConn) Close(code int, reason string) {
	c.closeOnce.Do(func() {
		c.closing <- closeRequest{code: code, reason: reason}
	})
}

func (c *wsConn) shut() {
	c.doneOnce.Do(func() {
		close(c.done)
		_ = c.ws.Close()
	})
}

func (c *wsConn) write(messageType int, data []byte) error {
	_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
	return c.ws.WriteMessage(messageType, data)
}

func (c *wsConn) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer c.shut()

	for {
		select {
		case msg := <-c.send:
			if err := c.write(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.write(websocket.PingMessage, nil); err != nil {
				return
			}
		case req := <-c.closing:
			c.flushAndClose(req)
			return
		case <-c.readDone:
			// The handler may have asked for a close on its way out (a denied
			// join); that request must not lose the race against its own exit.
			select {
			case req := <-c.closing:
				c.flushAndClose(req)
			default:
			}
			return
		}
	}
}

// flushAndClose writes whatever is still queued — the message explaining the
// close (removed, ended) is queued just before it — then the close frame.
func (c *wsConn) flushAndClose(req closeRequest) {
	for {
		select {
		case msg := <-c.send:
			if err := c.write(websocket.TextMessage, msg); err != nil {
				return
			}
		default:
			_ = c.ws.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(req.code, req.reason), time.Now().Add(writeWait))
			return
		}
	}
}

// readLoop feeds messages to the session until the connection ends.
func (c *wsConn) readLoop(sess *meeting.Session) {
	// Generous for signaling bursts (a trickle of candidates arrives at once),
	// tight enough that one client cannot keep the meeting lock busy.
	limiter := rate.NewLimiter(40, 120)
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		_, raw, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
		if !limiter.Allow() {
			continue
		}
		msgType, data, err := meeting.ParseMessage(raw)
		if err != nil {
			c.Close(meeting.CloseProtocol, "malformed message")
			return
		}
		sess.Handle(msgType, data)
	}
}
