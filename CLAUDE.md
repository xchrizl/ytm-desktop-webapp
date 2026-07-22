# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web UI + WebSocket bridge for [YouTube Music Desktop](https://github.com/ytmdesktop/ytmdesktop)'s companion server API. It runs a Bun server that pairs with the companion server once, subscribes to its realtime player state over socket.io, and re-broadcasts that state to browser clients over a plain WebSocket while relaying playback commands back. The frontend (`public/`) is a dependency-free PWA.

Runtime is **Bun** (not Node), though `@types/node` is installed and its `Response` type occasionally clashes with Bun's — see the cast in `src/server.ts`.

## Commands

```bash
bun install                # install deps
bun run .                  # run the app (reads .env; needs REMOTE_IP etc.)
bun test                   # run all tests
bun test tests/api.test.ts # run a single test file
bun run typecheck          # tsc --noEmit
```

There is no lint or build step; Bun runs the TypeScript directly. Config comes from `.env` (copy `.env.example`). `REMOTE_IP`, `REMOTE_PORT`, `API_VERSION`, `APP_ID`, `APP_NAME`, `APP_VERSION` are required and validated at startup in `src/config.ts` (the process exits with a clear message if one is missing/invalid); `SERVER_PORT` (8080) and `TOKEN_FILE_PATH` (`token.txt`) are optional.

## Architecture

Startup is orchestrated in `src/index.ts`: start the web server **unconditionally** (so the UI is reachable even with no token or an unreachable host) → build the connection state machine → register the browser-driven control handlers (pairing / host change) → `connection.init()`, which connects with a persisted token if one exists, or sits `unpaired` waiting for the user to pair from the UI.

**Two servers, one process.** The companion server (YTM Desktop, upstream) is what we consume; our own Bun server (`src/server.ts`) is what browsers connect to. Don't conflate them.

- **`src/config.ts`** — reads and validates every env var exactly once at import time and exports a frozen `config`. Import `config` from here; never touch `process.env` elsewhere. Note: `remoteIp/remotePort/remoteHost/remoteBaseUrl` on `config` are only the *initial defaults* — the **live** companion host lives in `settings.ts` (it can be changed from the UI at runtime), so read the current host from there, not from `config`.
- **`src/settings.ts`** — runtime-mutable companion host. Seeds itself from the `config` defaults, then overlays any host persisted (to `SETTINGS_FILE_PATH`) by a previous UI change. `getRemoteBaseUrl()/getRemoteHost()` are the live values that `api.ts` and `server.ts` read; `setRemote()` updates them and persists. Imports only `config` (+ fs) so the graph stays acyclic — resetting `api.ts`'s cached base URL after a host change is the caller's job (`connection.ts`), not this module's.
- **`src/api.ts`** — all HTTP calls to the companion server. The versioned base URL (`…/api/v1`) isn't known until `GET /metadata` confirms the requested `API_VERSION` is supported; `getApiBaseUrl()` resolves this once and caches the promise (cleared on failure so it can retry, and via `resetApiBaseUrlCache()` when the host changes). The base URL comes from `settings.getRemoteBaseUrl()`. `ApiError`/`RateLimitError` wrap non-2xx responses. `/auth/request` and `/playlists` can block up to ~30s server-side, so they use a longer timeout.
- **`src/auth.ts`** — token lifecycle. A persisted token is trusted without validation. `readPersistedToken()` reads it; `pairToken(onCode?)` runs `requestcode` → user approves the code in YTM Desktop → `request` returns a token (written to `TOKEN_FILE_PATH`), invoking `onCode` with the code so `connection.ts` can surface it to the UI; `invalidateToken()` deletes it.
- **`src/socket.ts`** — the socket.io client to the companion's `/realtime` namespace. Subscribes to `state-update` plus `playlist-created`/`playlist-deleted`, surfacing each as a handler callback. It only manages the connection and classifies errors (auth-related vs. not, via `looksLikeAuthError` message matching — the API has no defined auth-error shape); it does **not** decide auth policy. The target host is captured at socket construction, so switching hosts means disconnecting and building a fresh socket.
- **`src/connection.ts`** — the connection/auth **state machine** (`createConnection`). Owns the token + socket and emits a `ConnectionStatus` (`unpaired`/`pairing`/`connecting`/`connected`/`disconnected`/`auth-error`/`error`) through an injected `onStatus` callback. Exposes `init()`, `startPairing()`, `changeHost()`. On a socket auth-error it drops the token and goes `auth-error` (the user re-pairs from the UI — deliberately **not** silent auto-pairing). Decoupled from `server.ts`: it never imports it; `index.ts` wires `onStatus`→`broadcastStatus` and `onToken`→`setCurrentToken`.
- **`src/state.ts`** — a tiny in-memory pub/sub holding the latest `playerState` + `connected` flag. `subscribe()` fires immediately with the current snapshot, then again on every change. This is the seam between the upstream socket and the browser-facing server.
- **`src/server.ts`** — Bun.serve hosting static files from `public/` and the `/ws` WebSocket. It subscribes to `state` and broadcasts snapshots to all browser clients, relays incoming command messages to `api.sendCommand`, and serves `getPlaylists` (cached 5 min; the endpoint is slow and rate-limited). It also broadcasts the connection `status` (via `broadcastStatus`, sent on connect + on every change) and accepts two **control messages** that work even while unauthenticated — `{type:"startPairing"}` and `{type:"setHost",ip,port}` — dispatched to handlers registered by `index.ts` via `setControlHandlers`. `addPlaylist`/`removePlaylist` (called from `index.ts` on the realtime playlist events) patch that cache in place and broadcast the updated list to every client, so playlist changes show up live instead of waiting for the 5-min cache to expire. They no-op when the cache is empty (no baseline to patch) and don't touch the cache's timestamp, so the periodic full re-fetch still runs as a resync safety net.

### Two non-obvious optimizations in `server.ts`

- **Queue-diff broadcasts.** State updates arrive on every progress tick, but the (large) queue rarely changes. When the serialized queue matches the last broadcast, it's omitted and the message carries `queueOmitted: true`; the client (`public/app.js`) reuses its cached queue. New connections always get a full snapshot.
- **Static routes are preloaded and frozen at startup.** `buildStaticRoutes()` reads every file in `public/` into buffered `Response`s once, giving native ETag/304 handling with no per-request disk I/O. **Editing a file in `public/` requires restarting the server to see the change.**

### Frontend (`public/`)

Vanilla JS, no framework or build. `app.js` opens `/ws` (auto-reconnect with backoff), renders player state, and derives displayed progress from a real-time anchor rather than a ticking counter (avoids stutter from server updates fighting a local timer). The ⚙ settings panel is driven by the server's `status` message: it shows pairing state (including the code to confirm in YTM Desktop), a **Pair**/re-pair button, and inputs to switch the companion host (`setHost`). `sw.js` is a deliberately network-only service worker — it exists only for PWA installability, no caching. Known limitation: the companion API reports no shuffle state, so the shuffle button tracks its on/off state locally (each click toggles the red `active` style); this can drift if shuffle is changed directly in the desktop app.

## Testing

Tests use `bun:test`. `bunfig.toml` preloads `tests/setup.ts`, which sets all required env vars (so `src/config.ts` loads) and starts `tests/mock-companion-server.ts` — a fake companion server so tests never need the real YTM Desktop app. When adding tests that touch config, remember env vars are read once at import time.

## Docker & deploy

The app ships as a GHCR image. `Dockerfile` is multi-stage and **runs `bun test` during the build** (the `prerelease` stage), so a failing test breaks the image build. `docker-compose.yml` pulls `:latest` and persists the token **and runtime settings** (`SETTINGS_FILE_PATH`, the UI-set host) on a named volume; `docker-compose.truenas.yml` is a single self-contained variant with inline env and Traefik networking. See `README.md` for the manual build/push commands.

`.github/workflows/ci.yml` runs the tests on every push/PR to `main`, and on pushes to `main` also builds and pushes the GHCR image (`:latest` and `:${sha}`).
