# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Open Meet is a Google Meet–style video meeting app: a Go server (`server/`) that serves a REST API, a per-meeting signaling WebSocket, a Pion v4 SFU and the built client, and a React 19 + Vite + TypeScript client (`web/`). It descends from the voice/video rooms in the sibling `../inox` repo, which is a read-only reference — never change inox from here.

## Commands

- `make dev` — Go server on :8088 plus Vite on :5188 (`./dev.sh`); Vite proxies `/api` (with WebSocket upgrades) to the server
- `make build` — `web/dist` plus `bin/meet`; run the binary from `server/` (or set `MEET_WEB_DIR`) so it serves the client
- `make test` — `go vet`, `go test -race ./...`, web typecheck and lint
- Single Go test: `cd server && go test ./internal/sfu -run TestRoomForwards -v`
- Web: `cd web && npx tsc --noEmit -p tsconfig.app.json`, `npm run lint`, `npm run build`. There is no unit test runner.
- Browser tests: start a server, then `cd e2e && npm test` (or `node core.mjs` / `moderation.mjs` / `mobile.mjs`). They drive `/usr/bin/google-chrome` (override with `CHROME_PATH`) with fake devices; `BASE` picks the server. Screenshots land in `e2e/shots/`.

## Architecture

### Server (`server/internal/`)
- `sfu` — media plane. `Engine` holds the Pion API (Opus + VP8 only, no RTX, audio-level header extension, default interceptors) and the single-port UDP mux / ICE-TCP mux. `Room` → `Peer` (one per participant) → `Publication` (one per published track, up to 3 simulcast layers keyed by RID q/h/f) → `DownTrack` (one per subscriber per publication).
- `meeting` — `Registry` (records in a `Store`, live meetings in memory), `Meeting` (participants, lobby, chat, settings, host actions, resume), wire types in `protocol.go`.
- `server` — routes, origin/CORS checks, per-IP rate limits, WebSocket pumps (`conn.go`), SPA fallback.
- `config` — env (plus `server/.env`, which never overrides real env vars).

### Invariants worth knowing
- **Negotiation**: the SFU is the impolite peer, the browser polite (as in inox). The browser publishes on transceivers it creates once as `sendonly`. Pion will not reuse those for sending because their remote direction is sendonly. Every subscription gets an SFU-created `sendonly` transceiver. Freed transceivers move `retiring` → `inFlight` → `free` as offers and answers complete, and are reused with `SetSender` only once the browser has applied them as inactive. Reusing one any earlier skips the inactive transition, and the browser then never fires `ontrack`.
- **Track identity** is the msid: `<kind>.<participantID>` on both stream and track (`sfu.TrackName`). Participant IDs never contain dots. The browser declares what each of its MediaStream IDs is (`streams` on every offer/answer); undeclared video is treated as a camera.
- **Answers are sent from under `Peer.mu`**, so an SFU offer can't overtake the answer the browser is waiting for.
- **Lock order**: `Registry.mu` → `Meeting.mu` → `Participant.connMu`. The SFU calls the meeting (`Signaler`) from under its own locks, so the meeting must never call the SFU while holding `Meeting.mu`. Commit the state change, unlock, then call media.
- `Conn.Send` never blocks; a client whose 256-message queue fills is disconnected (and resumes).
- **DownTrack** forwards one layer. It switches only on a keyframe of the target layer. Every new segment (start, layer switch, resume from `off`) is rebased so sequence numbers, timestamps and VP8 picture ID/TL0PICIDX continue from what the subscriber already has. Header extensions are dropped on forward, because their IDs belong to the publisher's session.
- Camera and screen toggles are `replaceTrack`, and the SFU can't observe them. `media_state` reports them, and the roster is the source of truth for `video_on`/`screen_sharing`/`audio_muted`.
- The roster (`participants`) and lobby are always sent whole, and clients replace theirs.
- Resume: a dropped socket keeps the participant for `MEET_RECONNECT_GRACE`. A `join` with the resume token re-attaches it and calls `Room.Resync`, which re-sends a pending SFU offer. The client's first offer on a new `RTCPeerConnection` carries `restart: true` so the server drops the old peer.

### Client (`web/src/`)
- `meeting/controller.ts` — `MeetingController` owns the `Signaling` socket, the `RtcSession` and local tracks for one meeting. Components never touch WebRTC directly.
- `lib/rtc/session.ts` — the peer connection: serialized signaling chain, deferred negotiation, implicit rollback on collision, 3-layer camera simulcast, `resync()` after reconnects.
- `lib/protocol.ts` mirrors `server/internal/meeting/protocol.go`; change both together.
- State: `state/meeting.ts` (zustand). Audio levels live in a separate `useLevels` store so only level displays re-render at 5 Hz. Toasts are in `state/toast.ts`.
- Tiles report their device-pixel height via `controller.reportTile`, which becomes the `subscriptions` quality map (`off` for tiles not on screen). Tiles whose camera is off still request their layer, so the first frame arrives as soon as the camera comes back.
- `VideoView` stays invisible until `requestVideoFrameCallback` reports a painted frame. Receiver tracks are recycled between people, so "has a track" doesn't mean "has a picture".
- `AudioRenderer` calls `play()` and retries on the next gesture. Don't rely on the `autoplay` attribute (same lesson as inox).
- `window.__meet` exposes `{ controller, useMeeting, useLevels }` for debugging and the browser tests.

### Styling
CSS Modules with tokens in `src/styles/theme.css` (colors, spacing, radii, motion). Entrance animations go through `--animate-*` variables because CSS Modules rename keyframes referenced by name. The landing page and green room follow the system color scheme; the call (`data-surface="call"`) is always dark, and the side panel is a light card on it. Use `cx()` to join classes. Reuse `components/common` (`Button`, `IconButton` with tooltip, `Menu`, `Dialog`, `Switch`, `Toaster`, `Avatar`).
