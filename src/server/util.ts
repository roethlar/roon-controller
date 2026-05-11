export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error == null) {
    return "Unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

/**
 * Hierarchies the public Roon extension API exposes (per the
 * RoonApiBrowse docs and confirmed by the live probe in
 * scripts/probe-hierarchies.mjs). Anything outside this set is
 * either a private service we can't reach or a typo. We reject
 * unknown values rather than forwarding them to Roon, which
 * returns a generic error that leaks little debugging info.
 *
 * `tracks` isn't in the documented list but the controller's
 * welcomeStatsStore probes it optimistically; the backend should
 * accept it so the probe can either succeed or fail at Roon's
 * gate, not ours.
 */
export const ALLOWED_BROWSE_HIERARCHIES = new Set<string>([
  "browse",
  "search",
  "playlists",
  "settings",
  "internet_radio",
  "albums",
  "artists",
  "genres",
  "composers",
  "tracks",
]);

export function isAllowedHierarchy(hierarchy: string | undefined): boolean {
  return typeof hierarchy === "string" && ALLOWED_BROWSE_HIERARCHIES.has(hierarchy);
}
