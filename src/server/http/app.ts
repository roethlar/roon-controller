import path from "path";
import fs from "fs";
import express, { Application } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Logger } from "pino";
import { createHealthRouter } from "./routes/health";
import { createCoreRouter } from "./routes/core";
import { createZonesRouter } from "./routes/zones";
import { createTransportRouter } from "./routes/transport";
import { createBrowseRouter } from "./routes/browse";
import { createImageRouter } from "./routes/image";
import { createRecentlyPlayedRouter } from "./routes/recently-played";
import { createErrorHandler } from "./middleware/errorHandler";
import { RoonClient } from "../../core/roon/RoonClient";
import { TransportService } from "../../core/roon/TransportService";
import { BrowseService } from "../../core/roon/BrowseService";
import { ImageService } from "../../core/roon/ImageService";
import { RecentlyPlayedService } from "../../core/recently-played/RecentlyPlayedService";
import { ErrorResponse } from "../../shared/types";

export const createHttpApp = (
  roonClient: RoonClient,
  transportService: TransportService,
  browseService: BrowseService,
  imageService: ImageService,
  recentlyPlayedService: RecentlyPlayedService,
  logger: Logger
): Application => {
  const app = express();

  app.disable("x-powered-by");

  // Helmet defaults are tuned for typical web apps. The CSP override:
  //   - styleSrc 'unsafe-inline' for Svelte's scoped <style> blocks.
  //   - scriptSrc 'unsafe-inline' for (a) SvelteKit's static-build boot
  //     script that calls kit.start() and (b) the theme pre-hydration
  //     script in app.html. Both are inline by design; using nonces would
  //     require server-side template injection that the static adapter
  //     doesn't support out of the box. For LAN-appliance use the marginal
  //     defense lost is small relative to having a working page.
  //   - same-origin image/connect (the SvelteKit static build calls
  //     /api/* and /socket.io on the same host:port).
  //   - upgradeInsecureRequests removed: this server is HTTP-only on the
  //     LAN and modern browsers carve out RFC1918 from upgrade anyway,
  //     but explicit removal avoids surprises behind a non-HTTPS proxy.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          fontSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );

  app.use(express.json({ limit: "32kb" }));

  // Rate limit /api/* — generous for normal use, low enough to throttle
  // abusive clients on a LAN. Trust proxy not enabled by default; if the
  // service is fronted by a reverse proxy that should be configured by
  // setting TRUST_PROXY=true (handled below).
  if (process.env.TRUST_PROXY === "true") {
    app.set("trust proxy", 1);
  }
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests" } satisfies ErrorResponse,
  });
  app.use("/api", apiLimiter);

  app.use(createHealthRouter(recentlyPlayedService));
  app.use("/api/core", createCoreRouter(roonClient));
  app.use("/api/zones", createZonesRouter(transportService));
  app.use("/api/transport", createTransportRouter(transportService));
  app.use("/api/browse", createBrowseRouter(browseService));
  app.use("/api/image", createImageRouter(imageService));
  app.use("/api/recently-played", createRecentlyPlayedRouter(recentlyPlayedService));

  // Any unmatched /api/* request is an API miss — return JSON 404 instead of
  // falling through to the SPA HTML, which would confuse the API client's
  // response.json() parser.
  app.use("/api", (_req, res) => {
    const response: ErrorResponse = { error: "Not Found" };
    res.status(404).json(response);
  });

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
