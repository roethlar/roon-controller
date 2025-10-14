import path from "path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly roonTokenPath: string;
}

const resolvePath = (value: string | undefined, fallback: string): string => {
  return value && value.trim().length > 0 ? value : fallback;
};

export const loadConfig = (): AppConfig => {
  const host = resolvePath(process.env.HOST, "0.0.0.0");
  const port = Number(process.env.PORT ?? "3333");
  const logLevel = resolvePath(process.env.LOG_LEVEL, "info");

  const roonTokenPath = path.resolve(
    resolvePath(process.env.ROON_TOKEN_PATH, "./config/roon-token.json")
  );

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 3333,
    logLevel,
    roonTokenPath,
  };
};
