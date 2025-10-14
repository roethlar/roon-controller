import express, { Application } from "express";
import { Logger } from "pino";
import { createHealthRouter } from "./routes/health";
import { createCoreRouter } from "./routes/core";
import { createZonesRouter } from "./routes/zones";
import { createTransportRouter } from "./routes/transport";
import { createBrowseRouter } from "./routes/browse";
import { createImageRouter } from "./routes/image";
import { createErrorHandler } from "./middleware/errorHandler";
import { RoonClient } from "../../core/roon/RoonClient";
import { TransportService } from "../../core/roon/TransportService";
import { BrowseService } from "../../core/roon/BrowseService";
import { ImageService } from "../../core/roon/ImageService";

export const createHttpApp = (
  roonClient: RoonClient,
  transportService: TransportService,
  browseService: BrowseService,
  imageService: ImageService,
  logger: Logger
): Application => {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  app.use(createHealthRouter());
  app.use("/api/core", createCoreRouter(roonClient));
  app.use("/api/zones", createZonesRouter(transportService));
  app.use("/api/transport", createTransportRouter(transportService));
  app.use("/api/browse", createBrowseRouter(browseService));
  app.use("/api/image", createImageRouter(imageService));

  // Error handling middleware (must be last)
  app.use(createErrorHandler(logger));

  return app;
};
