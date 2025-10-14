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
  const imageService = new ImageService(roonClient, logger);

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

  // Wire RoonClient events to Socket.IO
  roonClient.on("core-status", (event) => {
    logger.info(event, "Roon core status update");
    socketContext.io.emit("core-status", event);
  });

  // Wire TransportService events to Socket.IO
  transportService.on("zone-updated", (data) => {
    socketContext.io.emit("zone-updated", data);
    socketContext.io.emit("zones", { zones: transportService.getZones() });
  });

  transportService.on("now-playing-updated", (data) => {
    socketContext.io.emit("now-playing-updated", data);
  });

  browseService.on("browse-result", (result) => {
    socketContext.io.emit("browse-result", result);
  });

  browseService.on("search-result", (results) => {
    socketContext.io.emit("search-result", results);
  });

  // Start all services
  roonClient.start();
  transportService.start();
  imageService.start();

  // Subscribe to zone updates
  transportService.subscribeZones();

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
