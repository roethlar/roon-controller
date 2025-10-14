# Roon Controller (WIP)

A fresh Node.js + SvelteKit stack for controlling a Roon Core without the
native desktop client. The focus is a single-user, single-zone controller that
runs cleanly on macOS or Linux.

## Stack Overview

- **Backend:** Node.js (TypeScript), Express, Socket.IO
- **Roon Integration:** `node-roon-api` + transport/browse/image services
- **Frontend:** SvelteKit (to be added)
- **Logging:** Pino

## Local Development

```bash
# install dependencies
npm install

# run the TypeScript backend (default host/port)
npm run dev

# build for production
npm run build
npm start
```

Environment variables can be specified in a `.env` file at the project root.
Key settings:

| Variable | Description | Default |
| --- | --- | --- |
| `HOST` | Bind address | `0.0.0.0` |
| `PORT` | HTTP server port (1-65535) | `3333` |
| `LOG_LEVEL` | Pino log level | `info` |
| `ROON_TOKEN_PATH` | Path to cached pairing token | `./config/roon-token.json` |

Copy `.env.example` as a starting point and adjust as needed.

## Running Natively (macOS / Linux)

1. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

2. Start the server:

   ```bash
   node dist/index.js
   ```

3. On macOS you can install the included launchd plist:

   ```bash
   sudo mkdir -p "/Library/Application Support/RoonController"
   sudo cp -R dist config package*.json "/Library/Application Support/RoonController"
   sudo mkdir -p /Library/Logs/RoonController
   sudo cp deploy/roon-controller.plist /Library/LaunchDaemons/com.roonlabs.controller.plist
   sudo launchctl load /Library/LaunchDaemons/com.roonlabs.controller.plist
   ```

   Logs are written to `/Library/Logs/RoonController` by default.

4. On Linux (systemd) use the service file under `deploy/`:

   ```bash
   sudo cp deploy/roon-controller.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now roon-controller
   ```

## Windows Service

To run as a Windows service, copy the build output to `C:\Program Files\RoonController` (or pass a custom path) and run:

```powershell
cd deploy
.\install-windows-service.ps1 -ServiceName "RoonController"
Start-Service -Name RoonController
```

Adjust `-InstallPath` or `-NodePath` if Node.js or the application lives elsewhere. The script registers the service via `sc.exe`, sets environment variables in the registry, and configures automatic restart on failure.

## Status

The backend and SvelteKit frontend are feature-complete for core playback,
library browsing, search, and error reporting.
