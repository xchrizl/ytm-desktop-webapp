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

Startup is orchestrated in `src/index.ts`: resolve the companion API base URL → get a token → start the web server → connect the realtime socket, wiring its callbacks to shared state.

**Two servers, one process.** The companion server (YTM Desktop, upstream) is what we consume; our own Bun server (`src/server.ts`) is what browsers connect to. Don't conflate them.

- **`src/config.ts`** — reads and validates every env var exactly once at import time and exports a frozen `config`. Import `config` from here; never touch `process.env` elsewhere.
- **`src/api.ts`** — all HTTP calls to the companion server. The versioned base URL (`…/api/v1`) isn't known until `GET /metadata` confirms the requested `API_VERSION` is supported; `getApiBaseUrl()` resolves this once and caches the promise (cleared on failure so it can retry). `ApiError`/`RateLimitError` wrap non-2xx responses. `/auth/request` and `/playlists` can block up to ~30s server-side, so they use a longer timeout.
- **`src/auth.ts`** — token lifecycle. A persisted token is trusted without validation; if it turns out to be stale, the socket's auth-error path re-pairs. Pairing = `requestcode` → user approves the code in YTM Desktop → `request` returns a token, which is written to `TOKEN_FILE_PATH`.
- **`src/socket.ts`** — the socket.io client to the companion's `/realtime` namespace. Subscribes to `state-update` plus `playlist-created`/`playlist-deleted`, surfacing each as a handler callback. It only manages the connection and classifies errors (auth-related vs. not, via `looksLikeAuthError` message matching — the API has no defined auth-error shape); it does **not** decide auth policy. `index.ts` owns the re-pair-on-auth-error logic (guarded against concurrent re-auth).
- **`src/state.ts`** — a tiny in-memory pub/sub holding the latest `playerState` + `connected` flag. `subscribe()` fires immediately with the current snapshot, then again on every change. This is the seam between the upstream socket and the browser-facing server.
- **`src/server.ts`** — Bun.serve hosting static files from `public/` and the `/ws` WebSocket. It subscribes to `state` and broadcasts snapshots to all browser clients, relays incoming command messages to `api.sendCommand`, and serves `getPlaylists` (cached 5 min; the endpoint is slow and rate-limited). `addPlaylist`/`removePlaylist` (called from `index.ts` on the realtime playlist events) patch that cache in place and broadcast the updated list to every client, so playlist changes show up live instead of waiting for the 5-min cache to expire. They no-op when the cache is empty (no baseline to patch) and don't touch the cache's timestamp, so the periodic full re-fetch still runs as a resync safety net.

### Two non-obvious optimizations in `server.ts`

- **Queue-diff broadcasts.** State updates arrive on every progress tick, but the (large) queue rarely changes. When the serialized queue matches the last broadcast, it's omitted and the message carries `queueOmitted: true`; the client (`public/app.js`) reuses its cached queue. New connections always get a full snapshot.
- **Static routes are preloaded and frozen at startup.** `buildStaticRoutes()` reads every file in `public/` into buffered `Response`s once, giving native ETag/304 handling with no per-request disk I/O. **Editing a file in `public/` requires restarting the server to see the change.**

### Frontend (`public/`)

Vanilla JS, no framework or build. `app.js` opens `/ws` (auto-reconnect with backoff), renders player state, and derives displayed progress from a real-time anchor rather than a ticking counter (avoids stutter from server updates fighting a local timer). `sw.js` is a deliberately network-only service worker — it exists only for PWA installability, no caching. Known limitation: the companion API reports no shuffle state, so the shuffle button only flashes as click feedback.

## Testing

Tests use `bun:test`. `bunfig.toml` preloads `tests/setup.ts`, which sets all required env vars (so `src/config.ts` loads) and starts `tests/mock-companion-server.ts` — a fake companion server so tests never need the real YTM Desktop app. When adding tests that touch config, remember env vars are read once at import time.

## Docker & deploy

The app ships as a GHCR image. `Dockerfile` is multi-stage and **runs `bun test` during the build** (the `prerelease` stage), so a failing test breaks the image build. `docker-compose.yml` pulls `:latest` and persists the token on a named volume; `docker-compose.truenas.yml` is a single self-contained variant with inline env and Traefik networking. See `README.md` for the manual build/push commands.

`.github/workflows/ci.yml` runs the tests on every push/PR to `main`, and on pushes to `main` also builds and pushes the GHCR image (`:latest` and `:${sha}`).
