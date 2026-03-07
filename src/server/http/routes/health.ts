import { Request, Response, Router } from "express";

export const createHealthRouter = (): Router => {
  const router = Router();

  const handler = (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  };

  router.get("/health", handler);
  router.get("/api/health", handler);

  return router;
};
