import pino, { Logger } from "pino";
import { AppConfig } from "../config/env";

let loggerInstance: Logger | null = null;

export const createLogger = (config: AppConfig): Logger => {
  if (loggerInstance) {
    return loggerInstance;
  }

  loggerInstance = pino({
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
            },
          },
  });

  return loggerInstance;
};

export const getLogger = (): Logger => {
  if (!loggerInstance) {
    throw new Error("Logger not initialised. Call createLogger() first.");
  }
  return loggerInstance;
};
