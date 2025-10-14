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

# run the TypeScript backend in watch mode
npm run dev

# build for production
npm run build
npm start
```

Environment variables can be specified in a `.env` file at the project root.
Key settings:

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP server port | `3333` |
| `HOST` | Bind address | `0.0.0.0` |
| `LOG_LEVEL` | Pino log level | `info` |
| `ROON_TOKEN_PATH` | Path to cached pairing token | `./config/roon-token.json` |

## Status

This repository currently contains backend scaffolding only (HTTP server,
Socket.IO bridge, Roon pairing skeleton). Frontend and detailed Roon browse /
transport handling will follow.
