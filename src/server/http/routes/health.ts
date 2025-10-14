import { Router } from "express";

export const createHealthRouter = (): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  return router;
};
