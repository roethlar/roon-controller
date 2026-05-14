import type { RecentlyPlayedEntry } from "./types";

/**
 * Identity key for a recently-played entry. Two entries with the same
 * key are treated as the same track for dedup / bubble-to-front.
 *
 * Deliberately excludes `zone_id` and `played_at`: the same track is
 * "the same track" whether it played in a different room or at a
 * different time. Shared between the backend RecentlyPlayedService
 * (which removes a prior occurrence on replay) and the frontend
 * recentlyPlayedStore (which mirrors that on each socket insert) so
 * the two never disagree on what counts as a duplicate.
 */
export function recentlyPlayedDedupeKey(entry: RecentlyPlayedEntry): string {
  return [
    entry.title ?? "",
    entry.artist ?? "",
    entry.album ?? "",
    entry.duration ?? "",
    entry.image_key ?? "",
  ].join("|");
}
