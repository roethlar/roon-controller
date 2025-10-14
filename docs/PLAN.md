# Project Plan – Roon Controller (AI-Friendly)

> **Purpose**  
> This document keeps the project understandable across AI sessions with limited
> context. Every task is bite-sized, self-contained, and includes guard‑rails
> against typical AI mistakes (overwriting files, skipping tests, etc.).

---

## 1. Guiding Principles

1. **Small, Composable Modules**  
   - Each feature lives in its own file/folder (`src/core/roon`, `src/server/http`, etc.).  
   - Avoid giant diffs; target ≤150 lines per change where possible.

2. **Incremental Delivery**  
   - Finish and verify one subtask before touching the next.  
   - Record progress at the bottom of this file in the _Progress Log_ table.

3. **Safety Checks**  
   - Never delete or rewrite generated tokens/config (`config/roon-token.json`).  
   - Run `npm run build` (backend) after TypeScript changes; add tests later.  
   - Log important events; do not swallow errors silently.

4. **Documentation First**  
   - Update this plan when scope changes.  
   - Inline TODOs (`// TODO(backend): handle queue updates`) are acceptable.

---

## 2. Architecture Snapshot

- **Backend** (`src/`)
  - `config/` – environment loading, typed config.
  - `core/logger.ts` – Pino logger singleton.
  - `core/roon/` – Roon API gateway (pairing, transport, browse, image).
  - `server/http/` – Express app and REST routes.
  - `server/socket/` – Socket.IO setup + event emitters.
  - `server/server.ts` – composition root tying HTTP, sockets, Roon gateway.
  - `index.ts` – bootstrap, graceful shutdown.

- **Frontend** (`ui/` – to be created)
  - SvelteKit app consuming REST + Socket.IO.
  - Shared TypeScript interfaces for data contracts (will live in `shared/`).

---

## 3. Work Breakdown (Modules & Subtasks)

### Stage A – Roon Gateway Foundation
1. **Token Persistence & Core Status (DONE)**  
   - `RoonClient` saves/loads token and emits `core-status`.
2. **Transport Service Wrapper**  
   - Methods: `playPause`, `next`, `previous`, `setVolume`, `subscribeZones`.  
   - Emit structured events (`zone-state`, `now-playing`) via Socket.IO.
3. **Browse/Search Service Wrapper**  
   - Expose `browse`, `load`, `pop`, `search`.  
   - Normalize outputs into typed interfaces (artists/albums/tracks).  
   - Handle pagination + search drill-down mirroring legacy behaviour.
4. **Image Proxy Helper**  
   - Stream artwork by key; cache headers where sensible.

### Stage B – Backend API Surface
1. **REST Endpoints**  
   - `/api/core` (status), `/api/zones`, `/api/now-playing`, `/api/browse`.  
   - Ensure responses use shared TypeScript interfaces.
2. **Socket Events**  
   - Broadcast updates: `core-status`, `zones`, `now-playing`, `queue`.  
   - Accept minimal commands (`playPause`, `seek`).
3. **Error Handling & Logging**  
   - Central middleware to format errors.  
   - Avoid throwing raw objects; use typed `RoonError`.

### Stage C – Frontend (SvelteKit)
1. **Project Scaffold**  
   - `ui/` directory with SvelteKit template, TypeScript enabled.
2. **State Stores**  
   - `coreStore`, `zonesStore`, `nowPlayingStore`, `browseStore`.
3. **Views**  
   - Dashboard (now playing, zone selector).  
   - Library browser (artists/albums/tracks with breadcrumbs).  
   - Search overlay.  
   - Queue view.
4. **Socket Integration**  
   - Use `socket.io-client` to sync stores.  
   - Implement optimistic UI for transport buttons.

### Stage D – Polish & Ops
1. **Config & Env Validation**  
   - Fail fast when required env vars missing.  
   - Document `.env.example`.
2. **Testing Strategy**  
   - Unit tests for services (Jest).  
   - Integration test harness for Roon (manual script or mock server).
3. **Packaging**  
   - `Dockerfile`, `docker-compose.yml`.  
   - Systemd service sample.
4. **Docs**  
   - Update `README.md` with setup, run, deploy steps.  
   - API reference (`docs/API.md`).  
   - Troubleshooting guide.

---

## 4. Safeguards Against AI Pitfalls

| Pitfall | Safeguard |
| --- | --- |
| Overwriting generated tokens | `.gitignore` already excludes `config/roon-token.json`; never write defaults on startup if file exists. |
| Inconsistent data contracts | Centralize interfaces in `src/shared/types.ts`; import everywhere. |
| Silent promise rejections | ESLint rule `@typescript-eslint/no-misused-promises`; always `await` async calls. |
| Large diffs beyond context window | Keep modules <150 LOC; break features into stages; update plan per change. |
| Forgetting to rebuild | Run `npm run build` post-change; note result in PR/commit message. |
| Missing logs | Use `logger.*` in every catch block; include context (core ID, zone ID). |

---

## 5. Progress Log

| Date (UTC) | Task | Notes |
| --- | --- | --- |
| 2025-10-14 | Initial scaffold | Backend TypeScript project, logger, RoonClient skeleton, Socket.IO wiring |

Add a row after each significant change. Include tests run & manual verification steps.
