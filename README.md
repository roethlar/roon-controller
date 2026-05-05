# Roon Controller

Web-based controller for a local Roon Core, built with Node.js + SvelteKit.

## Screenshots

| | |
|---|---|
| ![Browse](screenshots/browse-dark.png) | ![Albums](screenshots/albums.png) |
| ![Artists](screenshots/artists.png) | ![Tracklist](screenshots/tracklist.png) |
| ![Genres](screenshots/genres.png) | ![Light theme](screenshots/browse-light.png) |

## What Works

- Browse and search library with alphabetic jump lists, quick-play, and artwork caching
- Search result drill-down uses an isolated Roon browse session and remaps fresh result keys after re-seeding
- Real-time zone and now-playing updates via Socket.IO (hydrated on page load)
- Transport controls: play/pause, previous/next, seek, volume
- Queue: per-zone subscription, track listing with artwork, play-from-here, shuffle/loop/auto-radio
- Global zone switching, persistent play bar with track/artist deep-links
- Light/Dark theme with persisted preference

## Queue API Limitation

Roon's public transport API (`node-roon-api-transport`) does not expose remove/reorder endpoints. All currently available queue controls are implemented.

## Tech Stack

- **Backend**: Node.js, TypeScript, Express, Socket.IO
- **Roon**: `node-roon-api`, `node-roon-api-transport`, `node-roon-api-browse`, `node-roon-api-image`
- **Frontend**: SvelteKit (static adapter — no SSR required)
- **Logging**: Pino

## Repository Layout

```
src/       Backend TypeScript source
ui/        SvelteKit frontend (built to ui/build/)
scripts/   Installer scripts (Linux, macOS, Windows)
deploy/    Systemd service template
config/    Roon pairing token (gitignored)
Dockerfile Multi-stage build: backend + frontend → single image/port
DEVLOG.md  Recent engineering changes and validation notes
TODO.md    Active backlog and handoff items
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Description | Default |
|---|---|---|
| `HOST` | Bind address. `0.0.0.0` makes the UI reachable on the LAN; set `127.0.0.1` for localhost-only (recommended behind a reverse proxy) | `0.0.0.0` |
| `PORT` | HTTP port (serves API + UI) | `3333` |
| `LOG_LEVEL` | Pino log level. `trace` enables raw Roon payload dumps for debugging | `info` |
| `ROON_TOKEN_PATH` | Pairing token path | `./config/roon-token.json` |
| `IMAGE_CACHE_PATH` | Artwork disk cache | `./data/image-cache` |
| `IMAGE_CACHE_MAX_BYTES` | Disk cache cap (bytes); LRU eviction when exceeded | `10737418240` (10 GB) |
| `CLIENT_ORIGIN` | Comma-separated Socket.IO CORS allowlist, or `*` for any | `*` |
| `TRUST_PROXY` | Set to `true` when fronted by a reverse proxy so rate limits identify the real client IP | unset |

### Security notes

- The default `HOST=0.0.0.0` exposes the controller on every interface. There is **no built-in authentication** — anyone reachable on the network can browse, search, and control playback. For a single-purpose home appliance on a trusted LAN this is intentional. For anything broader, bind to `127.0.0.1` and front with a reverse proxy that adds auth, or set `CLIENT_ORIGIN` to your specific frontend origin(s).
- HTTP responses include Helmet defaults (CSP, `X-Content-Type-Options`, etc.). The `/api/*` surface is rate-limited to 600 requests/minute per IP.
- The Roon pairing token is written with file mode `0o600` under a directory created with mode `0o700`.

## Install

Each installer builds from source, deploys to a system directory, and registers a service that starts on boot. Run from the repository root.

### Linux

```bash
sudo ./scripts/install.sh
```

Options: `--port PORT`, `--install-dir DIR` (default: `/opt/roon-controller`), `--user USER` (default: `roon`), `--reinstall`, `--no-start`

### macOS

```bash
sudo ./scripts/install-macos.sh
```

Options: `--port PORT`, `--install-dir DIR` (default: `/opt/roon-controller`), `--reinstall`, `--no-start`

Installs as a launchd daemon. Logs at `/Library/Logs/RoonController/`.

### Windows

Requires [NSSM](https://nssm.cc/) (`winget install nssm` or `choco install nssm`). Run in an elevated PowerShell:

```powershell
.\scripts\install-windows.ps1
```

Options: `-Port`, `-InstallDir` (default: `C:\Program Files\RoonController`), `-Reinstall`, `-NoStart`

### Docker

```bash
docker compose build
docker compose up -d
```

The `./config/` and `./data/` volumes persist the Roon pairing token and artwork cache across restarts.

## Local Development

```bash
./scripts/run-local.sh        # installs deps and starts both servers
```

Or manually:

```bash
npm install && npm run dev                        # backend on :3333
cd ui && npm install && npm run dev -- --host     # frontend on :5173 (proxies /api → :3333)
```

## Validation

```bash
npm run build
npm test -- --runInBand
npm run lint
npm --prefix ui run check
npm --prefix ui test
npm --prefix ui run build
```

## Pairing

On first run: Roon → Settings → Extensions → enable **Custom Roon Controller**.

Token is cached at `ROON_TOKEN_PATH` and reconnect is automatic thereafter.

## Handoff

Read `DEVLOG.md`, `TODO.md`, `docs/PLAN.md`, `docs/CODE_REVIEW_2026-05-02.md`, `docs/CODE_REVIEW_2026-05-02_CLAUDE.md`, and `docs/CODE_REVIEW_COMPARISON_2026-05-02.md` before continuing work. Update them after meaningful changes, especially when fixing browse/search, queue, or zone-switching behavior.
