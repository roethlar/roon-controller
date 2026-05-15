import { Router, Request, Response, NextFunction } from "express";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";

/**
 * Routes for the rolling list of plays observed by this controller's
 * backend. Caveat: only what's been observed while the service was
 * running. UI should label this honestly.
 *
 * - GET    /api/recently-played  — current list
 * - DELETE /api/recently-played  — wipe the list (user-initiated)
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

  router.delete("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Await durability: the service only emits `cleared` (which
      // triggers the socket broadcast) after the file write commits.
      // A 200 here means every other client will agree the list is
      // empty AND the change survives a restart.
      await service.clear();
      res.json({ entries: [] });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
