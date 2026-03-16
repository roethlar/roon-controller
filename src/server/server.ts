import http from "http";
import { Application } from "express";
import { AppConfig } from "../config/env";
import { Logger } from "pino";
import { createHttpApp } from "./http/app";
import { attachSocketServer, SocketContext } from "./socket";
import { RoonClient } from "../core/roon/RoonClient";

export interface ServerContext {
  readonly httpServer: http.Server;
  readonly socketContext: SocketContext;
  readonly roonClient: RoonClient;
}

import { TransportService } from "../core/roon/TransportService";
import { BrowseService } from "../core/roon/BrowseService";
import { ImageService } from "../core/roon/ImageService";

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
  const imageService = new ImageService(roonClient, logger, config.imageCachePath);

  // Create HTTP app with services
  const app: Application = createHttpApp(
    roonClient,
    transportService,
    browseService,
    imageService,
    logger
  );
  const httpServer = http.createServer(app);

  const socketContext = attachSocketServer(httpServer, {
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

  // Wire TransportService events to Socket.IO
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
    socketContext.io.emit("zones", { zones: transportService.getZones() });
  });

  transportService.on("zone-removed", (data) => {
    socketContext.io.emit("zone-removed", data);
    socketContext.io.emit("now-playing-updated", {
      zone_id: data.zone_id,
      now_playing: null,
    });
    socketContext.io.emit("zones", { zones: transportService.getZones() });
  });

  transportService.on("now-playing-updated", (data) => {
    socketContext.io.emit("now-playing-updated", data);
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

  // Start all services
  roonClient.start();
  transportService.start();
  imageService.start();

  httpServer.listen(config.port, config.host, () => {
    logger.info(
      { host: config.host, port: config.port },
      "HTTP server listening"
    );
  });

  return {
    httpServer,
    socketContext,
    roonClient,
  };
};
