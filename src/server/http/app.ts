import express, { Application } from "express";
import { createHealthRouter } from "./routes/health";

export const createHttpApp = (): Application => {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  app.use(createHealthRouter());

  return app;
};
