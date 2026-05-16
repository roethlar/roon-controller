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
      // A 200 here means the clear committed and the file survived,
      // and the response body reflects the post-drain state — which
      // may be NON-EMPTY if a now-playing event landed during the
      // clear's persist window and was drained onto the empty list
      // before this line runs. The caller applies that snapshot
      // authoritatively instead of guessing whether a deferred
      // `inserted` socket event will (or already did) arrive.
      await service.clear();
      res.json({ entries: service.getEntries() });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
