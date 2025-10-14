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

export const startServer = (
  config: AppConfig,
  logger: Logger
): ServerContext => {
  const app: Application = createHttpApp();
  const httpServer = http.createServer(app);

  const socketContext = attachSocketServer(httpServer);

  const roonClient = new RoonClient({
    tokenPath: config.roonTokenPath,
    logger,
  });

  roonClient.on("core-status", (event) => {
    logger.info(event, "Roon core status update");
    socketContext.io.emit("core-status", event);
  });

  roonClient.start();

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
