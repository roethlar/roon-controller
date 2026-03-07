# Roon Controller

Web-based controller for a local Roon Core, built with Node.js + SvelteKit.

## What Works

- Browse and search library content with quick-play (click a track to play immediately)
- Real-time zone and now-playing updates via Socket.IO (hydrated on page load — no stale state on refresh)
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
deploy/    Systemd service, launchd plist, Windows service script
scripts/   Local dev helpers
config/    Roon pairing token (gitignored)
Dockerfile Multi-stage build: backend + frontend → single image/port
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Description | Default |
|---|---|---|
| `HOST` | Bind address | `0.0.0.0` |
| `PORT` | HTTP port (serves API + UI) | `3333` |
| `LOG_LEVEL` | Pino log level | `info` |
| `ROON_TOKEN_PATH` | Pairing token path | `./config/roon-token.json` |

## Local Development

```bash
./scripts/run-local.sh        # installs deps and starts both servers
```

Or manually:

```bash
npm install && npm run dev                        # backend on :3333
cd ui && npm install && npm run dev -- --host     # frontend on :5173 (proxies /api → :3333)
```

## Production

Build both, then start a single process that serves both the API and the static UI:

```bash
npm install && npm run build
cd ui && npm install && npm run build && cd ..
npm start                     # serves everything on PORT (default 3333)
```

## Validation

```bash
npm run build
npm test -- --runInBand
npm --prefix ui run check
npm --prefix ui run build
```

## Docker

```bash
docker compose build   # builds backend + frontend in one image
docker compose up -d
```

The `./config/` volume persists the Roon pairing token across restarts.

## Linux Systemd Install

```bash
# Build
npm install && npm run build
cd ui && npm install && npm run build && cd ..

# Deploy files
sudo mkdir -p /opt/roon-controller/config
sudo cp -r dist ui/build package*.json .env /opt/roon-controller/
sudo useradd -r -s /bin/false roon 2>/dev/null || true
sudo chown -R roon:roon /opt/roon-controller

# Install service
sudo cp deploy/roon-controller.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roon-controller
sudo journalctl -u roon-controller -f
```

## Pairing

On first run: Roon → Settings → Extensions → enable **Custom Roon Controller**.

Token is cached at `ROON_TOKEN_PATH` and reconnect is automatic thereafter.

## Open Backlog

- Queue polling fallback on reconnect after long disconnect
- Integration tests for socket queue commands
- Keyboard shortcuts for transport and browse
- Browse history breadcrumb visualization
