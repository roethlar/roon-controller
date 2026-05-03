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
| 2025-10-13 | A.2 Transport Service | Implemented TransportService with Promise-based playback controls, zone subscription with incremental updates (zones_changed/added/removed), npm run build ✅ |
| 2025-10-13 | A.4 Image Service | Implemented ImageService with streaming, cache headers, optional scaling parameters, npm run build ✅ |
| 2025-10-13 | B.1 REST Endpoints | Created 5 route files (core, zones, transport, browse, image) with typed request/response, service composition in server.ts, npm run build ✅ |
| 2025-10-13 | B.2 Socket Events | Implemented bidirectional Socket.IO (10 command listeners, event broadcasts), acknowledgment pattern with error handling, npm run build ✅ (Codex) |
| 2025-10-13 | B.3 Error Handling | Created typed error hierarchy (RoonError, CoreUnpairedError, etc.), Express error middleware, refactored all TODO markers, npm run build ✅ |
| 2025-10-13 | C.1-C.2 Frontend Foundation | SvelteKit scaffold, 4 stores (core, zones, nowPlaying, browse), REST client, Socket.IO client, npm run build ✅ (Codex) |
| 2025-10-13 | C.3 Views | Created Dashboard, Library browser, Search, Queue, Layout with Svelte 5 runes, npm run build ✅ (a11y warnings acceptable) |
| 2025-10-13 | C.4 Socket Integration | Socket event listeners in stores (Codex), ErrorToast component, optimistic UI for transport controls, hierarchy tracking in browseStore, npm run build ✅ |
| 2025-10-15 | D.1 Config & Env Validation | Added strict env parsing with ConfigError, .env.example, README updates, npm run build ✅ |
| 2025-10-15 | D.3 Packaging | Added Dockerfile, docker-compose, systemd, launchd plist, Windows service script, README instructions, npm run build ✅ |
| 2026-05-02 | Browse/Search Stability | Fixed search result drill-down state corruption; preserved zone and multi-session context through browse load/pop calls; npm run build, npm test -- --runInBand, npm --prefix ui run check, npm --prefix ui run build ✅ |
| 2026-05-02 | Code Review Batch 1 | Image cache hash + validation (path traversal P1), socket ack contract standardization, reconnect hydration via core-status on connect, REST/socket runtime validators, /api JSON 404, token mode 0o600, queue snapshot order preservation + invalid-id drop, errorMessage helper. 25 → 42 tests. All four validations green. See `docs/CODE_REVIEW_COMPARISON_2026-05-02.md` for source findings. |
| 2026-05-02 | Code Review Batch 2 | Helmet + rate-limit + CSV CLIENT_ORIGIN + TRUST_PROXY (LAN-appliance hardening); browse history → sessionStorage store; selectedZone → localStorage; volume type normalization (`db`/incremental→`relative`); volume slider in play bar; image cache LRU at 10 GB; browse paging (100/page + Load more/all + jump-bar auto-load); search UX (group by type, paginate per group, query label, persist on zone change); theme inline pre-hydration script; trace-level Roon payload dump for queue debugging; BrowseService EventEmitter cleanup; Roon graceful shutdown; README + .env.example updated. 42 → 44 tests. New deps: helmet, express-rate-limit. |
| 2026-05-02 | Queue protocol fix (C-3 full + C-20) | Captured raw subscribe_queue traffic from existing service journal. Roon's actual delta format is `{changes: [{operation: "insert"\|"remove", index, items?, count?}]}` — splice semantics, not the items_added/items_changed/items_removed the prior code looked for. Wired positional diff handler; row-0 = current-track invariant replaces fuzzy substring match. 5 new tests. 44 → 49. |
| 2026-05-02 | Codex follow-up fixes | Browse history restore now does popAll + replay full path via REST (P1). Dedup toasts: server sendError uses ack OR event, never both (P2). Socket validators mirror REST (boolean/loop enum/positive int) (P2). Queue splice ops with missing/invalid index or remove count are now refused with a warn log (P2). Zone fan-out: dropped redundant per-zone full-snapshot emits (P3). 49 → 51 tests. |
| 2026-05-02 | Search-rooted browse history restore | `BrowseHistoryState` now persists `searchQuery` alongside the stacks. `restoreBrowse` branches on the deepest saved step's hierarchy: search → re-seed Roon search session via the saved query then walk; browse → popAll then walk. Store hierarchy stays correct throughout restore so subsequent pop/forward target the right Roon multi-session. |
| 2026-05-02 | Mixed-hierarchy browse history | Two-layer fix: `pushHistory` resets the stack when hierarchy switches (browse↔search); `navigateSearchResult` and the search-fallback path in `quickPlay` explicitly `resetHistory()` so each search-result click starts a clean thread. Prevents `restoreBrowse` from replaying a browse step against a freshly-seeded search session, and prevents back/forward incoherence with mixed entries. |
| 2026-05-02 | sessionStorage migration sanitization | `readPersisted` sanitizes stored history to the contiguous tail matching the deepest step's hierarchy, so mixed entries written by older builds don't reach `restoreBrowse` on first remount after upgrade. Forward stack discarded if history was truncated; `searchQuery` cleared if the sanitized tail isn't search. |
| 2026-05-02 | Forward-stack migration sanitization | Forward stack must match history's tail hierarchy, not its own. Otherwise `popForward` would splice a foreign-hierarchy step directly into history, bypassing `pushHistory`'s guard. Now: forward kept only if every entry's hierarchy matches history's; discarded entirely when history is empty. |
| 2026-05-02 | Browse-history storage key versioned | Bumped sessionStorage key to `-v2` to drop any legacy multi-search-result history written before the resetHistory-on-search-click guard. One-time reset to browse root for users with active session history; sessionStorage's per-tab scope cleans the orphaned key when the tab closes. |
| 2026-05-02 | Socket connectivity polish (C-11 + C-18) | socket.io-client now tries websocket then polling so blocked upgrades fall back instead of leaving the UI silent. New `socketStatusStore` separates socket state from Roon core state; status pill shows Connecting / Disconnected / Searching for Core / Connected. `subscribe_zones` handler symmetry: both Subscribed and Changed now process seek changes (no-op when absent). |
| 2026-05-02 | C-11 fix corrections | Two bugs in the C-11 ship: (1) `transports` array alone doesn't fall back without `tryAllTransports: true` — added it. (2) `'disconnected'` status was defined but never set; now branches on disconnect reason (`'io server disconnect'`/`'io client disconnect'` → disconnected; everything else → connecting). New `reconnect_failed` listener on the manager flips to disconnected when retries are exhausted. |
| 2026-05-02 | Finite reconnection budget | Socket.IO defaults `reconnectionAttempts` to Infinity, so `reconnect_failed` is unreachable — the prior listener never fired. Set `reconnectionAttempts: 20`; with default backoff that's ~1.5 minutes before the UI flips to Disconnected and prompts refresh. |
| 2026-05-02 | UI test infrastructure | Vitest + jsdom set up in `ui/`. New scripts `npm --prefix ui test` and `test:watch`. 29 tests added covering `browseHistoryStore` (20: push/pop/forward/reset, sessionStorage round-trip, sanitization matrix, schema versioning), `socketStatusStore` (2), and `register.ts` connectivity transitions (9: connect/disconnect-reason branching, manager `reconnect_failed`, listener cleanup). New deps: vitest, jsdom. |
| 2026-05-03 | Svelte component tests | Added @testing-library/svelte + jest-dom + user-event. Vitest now loads the Svelte plugin so .svelte files compile in tests. 15 component tests: Search (10 — grouping, pagination, query label, callbacks, emit) and ErrorToast (5 — render, source labels, dismiss, auto-clear). Note: Svelte 5 batches reactivity, so post-render store updates need `await tick()` before DOM assertions. Total UI tests: 44; 95 across both halves. |
| 2026-05-03 | Library page integration tests | 11 tests covering the mount-restore matrix (empty / browse-rooted / search-rooted with and without query), zone forwarding, item-click emits + history recording, Home/Back via browseNavStore, loading state, failing-replay-step graceful degradation. Mocks `$lib/api/client` and `$lib/socket/client`; uses real stores. Total UI tests: 55; 106 across both halves. |
| 2026-05-03 | quickPlay + jump-bar + Load more tests | 10 more Library page tests: quickPlay happy path with album-view pop restore, no-play-action fallback to navigate, zone-unselected feedback, search-context skips pop, REST error feedback. Jump bar renders/threshold/scrollIntoView (stubbed). Load more bar shows correct counts and apiBrowseLoad offset/count. Total UI tests: 65; 116 across both halves. |
| 2026-05-03 | Installers up to date | All three installers (Linux/macOS/Windows): wipe `dist`+`ui/build` before redeploy to avoid stale files; `.env` template now mirrors `.env.example` (incl. `IMAGE_CACHE_MAX_BYTES` set, `CLIENT_ORIGIN`/`TRUST_PROXY` commented); `.env` is now preserved across `--reinstall` (was being clobbered, losing user customizations); macOS plist `EnvironmentVariables` and Windows NSSM `AppEnvironmentExtra` add `IMAGE_CACHE_MAX_BYTES`. |

Add a row after each significant change. Include tests run & manual verification steps.
