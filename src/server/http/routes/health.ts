import { Request, Response, Router } from "express";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";

/**
 * Per-subsystem diagnostic block included in the /api/health
 * response so operators can see readiness, monotonic epoch + revision,
 * entry count, and the most recent persistence failure (if any).
 * Pre-L-1 the response was just `{ status: "ok" }`, which masked
 * degraded RP state entirely.
 */
interface RecentlyPlayedHealth {
  ready: boolean;
  degraded: boolean;
  epoch: number;
  revision: number;
  entry_count: number;
  last_persist_error?: { message: string; ts: string };
}

export const createHealthRouter = (
  recentlyPlayedService?: RecentlyPlayedService
): Router => {
  const router = Router();

  const handler = (_req: Request, res: Response) => {
    const subsystems: { recently_played?: RecentlyPlayedHealth } = {};
    let ready = true;

    if (recentlyPlayedService) {
      const degraded = recentlyPlayedService.isDegraded();
      const rpReady = !degraded;
      ready = ready && rpReady;
      const rpHealth: RecentlyPlayedHealth = {
        ready: rpReady,
        degraded,
        epoch: recentlyPlayedService.getEpoch(),
        revision: recentlyPlayedService.getRevision(),
        entry_count: recentlyPlayedService.getEntries().length,
      };
      const lastErr = recentlyPlayedService.getLastPersistError();
      if (lastErr) rpHealth.last_persist_error = lastErr;
      subsystems.recently_played = rpHealth;
    }

    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "degraded",
      ready,
      timestamp: new Date().toISOString(),
      subsystems,
    });
  };

  router.get("/health", handler);
  router.get("/api/health", handler);

  return router;
};
