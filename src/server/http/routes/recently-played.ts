import { Router, Request, Response, NextFunction } from "express";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";

/**
 * GET /api/recently-played
 * Returns the rolling list of plays observed by this controller's
 * backend. Caveat: only what's been observed while the service was
 * running. UI should label this honestly.
 */
export const createRecentlyPlayedRouter = (
  service: RecentlyPlayedService
): Router => {
  const router = Router();

  router.get("/", (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ entries: service.getEntries() });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
