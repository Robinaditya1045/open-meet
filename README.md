# Open Meet

Video meetings in the browser, in the spirit of Google Meet: start a call in one
click, share the link, and anyone can join without an account.

It is built on the voice/video room design from [inox](../inox) — a Go server
running a Pion SFU, WebSocket signaling, and a React client — and takes it
further: simulcast, server-side speaker detection, a single UDP port, resumable
sessions, and the moderation tools a meeting app needs.

## Features

- **Meetings by link** — `abc-defg-hjk` codes, instant or "for later" meetings,
  host links that grant host rights, links that survive server restarts.
- **Green room** — camera and mic preview, device pickers, a live mic meter, who
  is already in the call, join muted or with the camera off, or join and present.
- **Calls** — auto-sizing grid, spotlight for presentations and pinned tiles, a
  two-person layout with a self-view picture-in-picture, "+N others" overflow
  that keeps recent speakers on screen, speaking rings and level bars.
- **Media** — camera, mic and screen share; device switching mid-call;
  noise suppression; hold Space to talk while muted; "are you talking?" hint.
- **In-call** — chat with history for late joiners and link detection, emoji
  reactions, raised hands with a queue, meeting details, keyboard shortcuts.
- **Hosts** — lock the meeting so guests knock (admit or deny from a toast or the
  People panel), mute one or all, remove, make co-host, lower hands, turn chat,
  presenting or reactions off for guests, end the call for everyone.
- **Resilience** — signaling reconnects with backoff and resumes the same
  participant (media keeps flowing through a socket drop), ICE restarts on
  network changes, a failed media connection rebuilds itself, and a server
  restart sends everyone back in.
- **Phones** — responsive layout down to 390px with a compact call bar.

## What's better than inox's voice rooms

| | inox | Open Meet |
|---|---|---|
| WebRTC stack | Pion v3 | Pion v4 |
| Video forwarding | one encoding to everyone | 3-layer simulcast; each viewer gets the layer that fits their tile, off-screen tiles get nothing |
| Layer switching | — | keyframe-aligned, with sequence number, timestamp and VP8 picture-ID rewriting so the splice is seamless |
| Who's speaking | decoded in every browser (WebAudio) | RTP audio-level headers read on the server; everyone agrees on the dominant speaker |
| Ports | a UDP range | one UDP port for every call, plus ICE-TCP fallback |
| Camera on/off, device switch | renegotiation | `replaceTrack` on pre-allocated sendonly transceivers — instant, no SDP |
| SDP growth | m-lines accumulate as people come and go | freed transceivers are recycled once the browser has seen them go inactive |
| Socket drop | rejoin | resume the same participant within a grace period; lost offers are re-sent |
| Deployment | API + frontends on separate origins | one binary serves API, signaling, SFU and the client |

## Architecture

```
 browser (React)                         server (Go, one process)
 ┌──────────────────────┐   WebSocket    ┌───────────────────────────────────┐
 │ MeetingController     │◄──────────────►│ server  ─ REST + /ws upgrade      │
 │  ├ Signaling (resume) │  join, roster, │ meeting ─ registry, participants, │
 │  ├ RtcSession         │  chat, SDP,    │           lobby, chat, hosts,     │
 │  │   mic  (sendonly)  │  ICE, levels   │           resume, file store      │
 │  │   camera q/h/f     │                │ sfu     ─ Room → Peer → Publication│
 │  │   screen           │   RTP (UDP     │           → DownTrack per viewer  │
 │  └ zustand stores     │◄──────────────►│           (layer pick + rewrite)  │
 └──────────────────────┘   7882 / TCP   │           speaker detector        │
                             7881)        └───────────────────────────────────┘
```

- `server/internal/sfu` — the media plane. Each publication reads its layers
  lock-free and fans packets out to one `DownTrack` per subscriber, which picks a
  simulcast layer from what the viewer asked for and what is actually arriving.
- `server/internal/meeting` — meeting state behind one mutex per meeting; the SFU
  reaches it only through the `Signaler` interface.
- `server/internal/server` — HTTP routes, origin checks, rate limits, the
  WebSocket pumps, and the SPA.
- `web/src/meeting/controller.ts` — the one object that owns a tab's socket, peer
  connection and devices. Components read stores and call it.

## Running it

Requirements: Go 1.24+, Node 22+, a Chromium, Firefox or Safari browser.

```sh
make dev          # Go server on :8088 and Vite on :5188 → open http://localhost:5188
```

or one binary:

```sh
make build        # builds web/dist and bin/meet
cd server && ../bin/meet   # serves everything on :8088
```

Camera and microphone need a secure context: `localhost` works; anything else
needs HTTPS (put Caddy or nginx in front for TLS and proxy `/` with WebSocket
upgrades to `:8088`).

### Docker

```sh
docker compose up --build
```

The compose file uses host networking so the SFU can advertise the machine's
real addresses. Without it, set `MEET_PUBLIC_IP` and publish `8088/tcp`,
`7881/tcp` and `7882/udp`.

## Configuration

Environment variables (or `server/.env`; see `server/.env.example`):

| Variable | Default | |
|---|---|---|
| `MEET_HTTP_ADDR` | `:8088` | API, signaling and the client |
| `MEET_RTC_UDP_PORT` | `7882` | the one UDP port all media uses |
| `MEET_RTC_TCP_PORT` | `7881` | ICE over TCP; `0` disables |
| `MEET_PUBLIC_IP` | — | public address behind 1:1 NAT (cloud VMs) |
| `MEET_RTC_EXCLUDE_INTERFACES` | `docker,br-,veth,virbr,lxc,tailscale` | interfaces never offered as candidates |
| `MEET_ICE_SERVERS` | — | STUN/TURN URLs handed to browsers |
| `MEET_TURN_USERNAME` / `MEET_TURN_CREDENTIAL` | — | credentials for the `turn:` URLs |
| `MEET_ALLOWED_ORIGINS` | `http://localhost:5188,…` | extra origins for the API and sockets |
| `MEET_TRUST_PROXY` | `false` | read client IPs from `X-Forwarded-For` |
| `MEET_DATA_DIR` | `./data` | where meeting links are persisted |
| `MEET_WEB_DIR` | `../web/dist` if present | the built client |
| `MEET_MAX_PARTICIPANTS` | `50` | per meeting, including the lobby |
| `MEET_RECONNECT_GRACE` | `20s` | how long a dropped participant keeps their place |
| `MEET_MEETING_TTL` | `2160h` | forget links unused for this long |
| `MEET_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Tests

```sh
make test         # go vet + go test -race, web typecheck + lint
make e2e          # browser tests against a running server (BASE=http://localhost:8088)
```

The Go suite includes an SFU test that connects real Pion peers through a room.
The browser suite (`e2e/`) drives headless Chrome with fake devices: three-way
calls, simulcast layer switching, speaker detection, chat, reactions, presenting,
the lobby, host controls, transceiver recycling, resume after a socket drop, and
phone layouts.

## Limits

One server hosts a meeting; there is no SFU cascading across nodes. Video is VP8
only (every browser encodes VP8 simulcast). No recording, captions, breakout
rooms, background effects or end-to-end encryption yet.
