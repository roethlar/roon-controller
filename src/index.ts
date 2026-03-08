import { ConfigError, loadConfig } from "./config/env";
import { createLogger } from "./core/logger";
import { startServer } from "./server/server";

const bootstrap = () => {
  try {
    const config = loadConfig();
    const logger = createLogger(config);

    logger.info("Bootstrapping Roon web controller");

    const context = startServer(config, logger);

    const shutdown = (signal: string) => {
      logger.info({ signal }, "Received shutdown signal");

      void context.socketContext.io.close(() => {
        logger.info("Socket server closed");
      });

      context.httpServer.close((error) => {
        if (error) {
          logger.error({ err: error }, "Error while closing HTTP server");
          process.exit(1);
        } else {
          logger.info("HTTP server closed");
          process.exit(0);
        }
      });
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
    } else {
      console.error("Fatal error during startup", error);
    }
    process.exit(1);
  }
};

bootstrap();
