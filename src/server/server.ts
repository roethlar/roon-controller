import http from "http";
import { Application } from "express";
import { AppConfig } from "../config/env";
import { Logger } from "pino";
import { createHttpApp } from "./http/app";
import { attachSocketServer, SocketContext } from "./socket";
import { RoonClient } from "../core/roon/RoonClient";

import { TransportService } from "../core/roon/TransportService";
import { BrowseService } from "../core/roon/BrowseService";
import { ImageService } from "../core/roon/ImageService";
import { RecentlyPlayedService } from "../core/recently-played/RecentlyPlayedService";

export interface ServerContext {
  readonly httpServer: http.Server;
  readonly socketContext: SocketContext;
  readonly roonClient: RoonClient;
  readonly transportService: TransportService;
  readonly recentlyPlayedService: RecentlyPlayedService;
  /**
   * httpServer.listen() is deferred until RecentlyPlayedService.start
   * resolves (so the API can't serve epoch-0 sentinel snapshots).
   * If shutdown is requested during that window, callers MUST signal
   * it via `requestShutdown()` so the listen call is skipped — and
   * MUST check `isListening()` before calling `httpServer.close()`,
   * which Node reports as an error when the server never bound.
   */
  requestShutdown(): void;
  isListening(): boolean;
}

export const startServer = (
  config: AppConfig,
  logger: Logger
): ServerContext => {
  // Instantiate RoonClient
  const roonClient = new RoonClient({
    tokenPath: config.roonTokenPath,
    logger,
  });

  // Instantiate services
  const transportService = new TransportService(roonClient, logger);
  const browseService = new BrowseService(roonClient, logger);
  const imageService = new ImageService(
    roonClient,
    logger,
    config.imageCachePath,
    config.imageCacheMaxBytes
  );
  const recentlyPlayedService = new RecentlyPlayedService(
    transportService,
    logger,
    {
      filePath: config.recentlyPlayedPath,
      cap: config.recentlyPlayedCap,
    }
  );
  recentlyPlayedService.setZoneNameLookup((zoneId) => {
    return transportService
      .getZones()
      .find((z) => z.zone_id === zoneId)?.display_name;
  });

  // Create HTTP app with services
  const app: Application = createHttpApp(
    roonClient,
    transportService,
    browseService,
    imageService,
    recentlyPlayedService,
    logger
  );
  const httpServer = http.createServer(app);

  const socketContext = attachSocketServer(httpServer, {
    roonClient,
    transportService,
    browseService,
    logger,
  });

  let zonesSubscribed = false;

  const trySubscribeZones = () => {
    if (zonesSubscribed) {
      return;
    }

    try {
      transportService.subscribeZones();
      zonesSubscribed = true;
      logger.info("Subscribed to Roon transport zones");
    } catch (error) {
      logger.warn({ err: error }, "Zone subscription deferred until core pairing completes");
    }
  };

  // Wire RoonClient events to Socket.IO
  roonClient.on("core-status", (event) => {
    logger.info(event, "Roon core status update");
    socketContext.io.emit("core-status", event);

    if (event.coreStatus === "paired") {
      transportService.start();
      imageService.start();
      zonesSubscribed = false;
      trySubscribeZones();
    }

    if (event.coreStatus === "unpaired") {
      zonesSubscribed = false;
      transportService.resetState();
      socketContext.io.emit("zones", { zones: [] });
    }
  });

  // Wire TransportService events to Socket.IO. The per-zone events
  // (`zone-updated`, `zone-removed`) are sufficient for the client to keep
  // its zone list in sync — `register.ts` calls upsertZone/removeZone on
  // them. We do NOT also emit a full `zones` snapshot per per-zone update,
  // because (a) it's quadratic broadcast traffic on Roon batches that
  // touch every zone (e.g. seek ticks), and (b) the initial snapshot is
  // already emitted on socket `connection`.
  transportService.on("zone-updated", (data) => {
    try {
      transportService.subscribeQueue(data.zone.zone_id);
    } catch (error) {
      logger.warn(
        { err: error, zone_id: data.zone.zone_id },
        "Queue subscription deferred for zone"
      );
    }

    socketContext.io.emit("zone-updated", data);
  });

  transportService.on("zone-removed", (data) => {
    socketContext.io.emit("zone-removed", data);
    socketContext.io.emit("now-playing-updated", {
      zone_id: data.zone_id,
      now_playing: null,
    });
  });

  transportService.on("now-playing-updated", (data) => {
    socketContext.io.emit("now-playing-updated", data);
  });

  // Broadcast recently-played updates with the post-mutation revision.
  // Clients track the highest revision they've applied and discard
  // anything not strictly newer — closes races where socket events
  // and REST responses arrive out of server-emit order.
  //
  // Suppressed in degraded mode (eager generation persist failed):
  // emitting with an uncommitted epoch would let clients adopt state
  // that can't survive a restart without epoch reuse.
  recentlyPlayedService.on("inserted", (entry) => {
    if (recentlyPlayedService.isDegraded()) return;
    socketContext.io.emit("recently-played-inserted", {
      entry,
      revision: recentlyPlayedService.getRevision(),
      epoch: recentlyPlayedService.getEpoch(),
    });
  });

  // A user-initiated wipe — broadcast so every client's list empties,
  // not just the one that issued the DELETE.
  recentlyPlayedService.on("cleared", () => {
    if (recentlyPlayedService.isDegraded()) return;
    socketContext.io.emit("recently-played-cleared", {
      revision: recentlyPlayedService.getRevision(),
      epoch: recentlyPlayedService.getEpoch(),
    });
  });

  transportService.on("queue-updated", (data) => {
    socketContext.io.emit("queue-updated", data);
  });

  transportService.on("seek-changed", (data) => {
    socketContext.io.emit("seek-changed", data);
  });

  // Browse results are emitted per-socket in the socket handlers,
  // not broadcast globally, so REST-initiated browse calls don't
  // interfere with clients' navigation state.

  // Start the sync services immediately; defer httpServer.listen until
  // RP has finished its async startup (loadFromDisk + eager generation
  // persist). Without this, GET /api/recently-played served during the
  // startup window would return the sentinel { entries: [], revision:
  // 0, epoch: 0 } and a DELETE in the same window would race the
  // load + clobber persisted history with empty epoch-0 state.
  roonClient.start();
  transportService.start();
  imageService.start();

  // Lifecycle state for the deferred-listen window. SIGTERM during
  // that window calls `requestShutdown()`; the pending startup then
  // skips listen() and `isListening()` reports false so the shutdown
  // handler can avoid `httpServer.close()` (which errors on a
  // never-bound server).
  let shutdownRequested = false;
  let listening = false;

  void recentlyPlayedService.start().then(
    () => {
      if (shutdownRequested) {
        logger.info(
          "Shutdown requested before RP startup completed; skipping httpServer.listen"
        );
        return;
      }
      httpServer.listen(config.port, config.host, () => {
        listening = true;
        logger.info(
          { host: config.host, port: config.port },
          "HTTP server listening"
        );
      });
    },
    (err) => {
      // Shouldn't happen — RecentlyPlayedService.start swallows all
      // failure modes internally (load errors recover as empty;
      // eager-persist failures set degraded mode). Defensive: log,
      // exit. Without this, an unexpected throw would silently leave
      // the HTTP server never starting.
      logger.error(
        { err },
        "RecentlyPlayedService.start unexpectedly rejected; HTTP server not started"
      );
      process.exit(1);
    }
  );

  return {
    httpServer,
    socketContext,
    roonClient,
    transportService,
    recentlyPlayedService,
    requestShutdown: () => {
      shutdownRequested = true;
    },
    isListening: () => listening,
  };
};
