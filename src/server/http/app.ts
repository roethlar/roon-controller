import path from "path";
import fs from "fs";
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

  // Serve the SvelteKit static build in production.
  // UI_BUILD_PATH can be set explicitly; defaults to sibling `ui/build/` dir.
  const uiBuildPath = path.resolve(
    process.env.UI_BUILD_PATH ?? path.join(__dirname, "../../../ui/build")
  );

  if (fs.existsSync(uiBuildPath)) {
    logger.info({ uiBuildPath }, "Serving frontend static files");
    app.use(express.static(uiBuildPath));
    // SPA fallback: serve index.html for any route not matched above
    app.use((_req, res) => {
      res.sendFile(path.join(uiBuildPath, "index.html"));
    });
  } else {
    logger.info("No UI build found; frontend must be served separately");
  }

  // Error handling middleware (must be last)
  app.use(createErrorHandler(logger));

  return app;
};
