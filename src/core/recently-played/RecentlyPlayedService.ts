import { EventEmitter } from "events";
import { promises as fs } from "fs";
import path from "path";
import { Logger } from "pino";
import type { NowPlaying, RecentlyPlayedEntry } from "../../shared/types";
import {
  recentlyPlayedDedupeKey,
  dedupeRecentlyPlayed,
} from "../../shared/recentlyPlayed";
import type { TransportService } from "../roon/TransportService";

export interface RecentlyPlayedServiceOptions {
  /**
   * On-disk path for the persisted JSON list. The directory will be
   * created if it doesn't exist. Caller's responsibility to ensure
   * the path is writable.
   */
  filePath: string;
  /** Maximum number of entries kept in the rolling list. */
  cap?: number;
  /**
   * Suppression window (ms). If a now-playing-updated event matches
   * the most-recent entry's dedupe key AND the new played_at falls
   * within this window of the existing entry, the event is dropped.
   * Catches rapid duplicates from Roon (seek, pause/resume, metadata
   * refresh) without dropping legitimate consecutive plays.
   */
  suppressionWindowMs?: number;
  /**
   * Optional clock for tests. Returns ms since epoch. Defaults to
   * Date.now.
   */
  now?: () => number;
}

/**
 * RecentlyPlayedService — tracks now-playing changes per zone and
 * persists the last N plays to disk so the welcome view can show
 * "Recently played on this controller."
 *
 * Honest scope: only captures plays that happen while the service is
 * running and subscribed to Roon. Plays that happen during downtime
 * are missed. The persisted file is local to this controller; it
 * doesn't pull history from Roon Core (no public API for that).
 *
 * Dedup model: the list holds at most one entry per track. A genuine
 * replay (same track, after the noise window) bubbles to the top —
 * the prior occurrence is removed and a fresh entry unshifted. Rapid
 * re-emits within the noise window (seek/pause/metadata-refresh,
 * group-play) are dropped entirely. See `shouldSuppress`.
 *
 * Events:
 * - `inserted`: emitted whenever the list's head changes — a new
 *   track OR a replay bubbling up. Carries the entry now at the top.
 *   Suppressed (noise-window) updates do NOT emit. Listeners
 *   broadcasting this to clients should mirror the bubble: drop any
 *   prior occurrence of the same track before prepending.
 * - `cleared`: emitted when the list is emptied via `clear()` (a
 *   user-initiated wipe). Carries no payload.
 */
export declare interface RecentlyPlayedService {
  on(event: "inserted", listener: (entry: RecentlyPlayedEntry) => void): this;
  on(event: "cleared", listener: () => void): this;
  emit(event: "inserted", entry: RecentlyPlayedEntry): boolean;
  emit(event: "cleared"): boolean;
}

export class RecentlyPlayedService extends EventEmitter {
  private readonly filePath: string;
  private readonly cap: number;
  private readonly suppressionWindowMs: number;
  private readonly now: () => number;
  private entries: RecentlyPlayedEntry[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private nowPlayingHandler?: (data: {
    zone_id: string;
    now_playing: NowPlaying;
  }) => void;
  private zoneNameLookup: (zoneId: string) => string | undefined = () =>
    undefined;

  constructor(
    private readonly transportService: TransportService,
    private readonly logger: Logger,
    options: RecentlyPlayedServiceOptions
  ) {
    super();
    this.filePath = options.filePath;
    this.cap = Math.max(1, Math.floor(options.cap ?? 50));
    this.suppressionWindowMs = Math.max(
      0,
      Math.floor(options.suppressionWindowMs ?? 30_000)
    );
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Load the persisted list (if any) and start listening for
   * now-playing-updated events. Safe to call multiple times — the
   * second call is a no-op for the listener registration.
   */
  public async start(): Promise<void> {
    await this.loadFromDisk();

    if (!this.nowPlayingHandler) {
      this.nowPlayingHandler = (data) => {
        try {
          this.handleNowPlaying(data.zone_id, data.now_playing);
        } catch (err) {
          this.logger.warn(
            { err },
            "RecentlyPlayedService: handler crashed; entry skipped"
          );
        }
      };
      this.transportService.on("now-playing-updated", this.nowPlayingHandler);
    }
  }

  /** Detach the now-playing listener. Idempotent. */
  public stop(): void {
    if (this.nowPlayingHandler) {
      this.transportService.off("now-playing-updated", this.nowPlayingHandler);
      this.nowPlayingHandler = undefined;
    }
  }

  /**
   * Provide a callback that returns the current display name for a
   * given zone id. The service stamps this onto each new entry so
   * we can show "played on Living Room" even after the zone is
   * renamed or removed.
   */
  public setZoneNameLookup(fn: (zoneId: string) => string | undefined): void {
    this.zoneNameLookup = fn;
  }

  /** Snapshot of the current list, newest first. */
  public getEntries(): RecentlyPlayedEntry[] {
    return [...this.entries];
  }

  /**
   * Empty the list (user-initiated wipe). Awaits persistence before
   * emitting `cleared` so the socket broadcast only fires once the
   * change is durable — otherwise a process crash between broadcast
   * and write would leave every client cleared but the file restored
   * on restart. On persist failure, rolls back the in-memory list to
   * keep it consistent with disk; the caller (the DELETE route) sees
   * the rejection and surfaces a 500 so the user can retry.
   *
   * No-op-safe if the list is already empty: still persists + emits,
   * which keeps the operation idempotent across clients.
   */
  public async clear(): Promise<void> {
    const previous = this.entries;
    this.entries = [];
    try {
      await this.schedulePersistAsync();
    } catch (err) {
      this.entries = previous;
      throw err;
    }
    this.emit("cleared");
  }

  // ── Internal ──────────────────────────────────────────────────────

  private handleNowPlaying(zoneId: string, nowPlaying: NowPlaying | null): void {
    if (!nowPlaying) return;
    // Defensive: zone_id might be on the now_playing payload too.
    const resolvedZoneId = zoneId || nowPlaying.zone_id;
    if (!resolvedZoneId) return;

    // Require at least a title — entries with nothing displayable
    // are noise.
    if (!nowPlaying.title) return;

    const entry: RecentlyPlayedEntry = {
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      album: nowPlaying.album,
      duration: nowPlaying.duration,
      image_key: nowPlaying.image_key,
      zone_id: resolvedZoneId,
      zone_name: this.zoneNameLookup(resolvedZoneId),
      played_at: new Date(this.now()).toISOString(),
    };

    if (this.shouldSuppress(entry)) {
      return;
    }

    // Not suppressed → either a brand-new track or a genuine replay
    // (same track, but the prior entry is outside the noise window).
    // Drop any prior occurrence so a replay bubbles to the top
    // instead of duplicating. `filter` (not splice-one) also cleans
    // up any legacy duplicates left by the pre-bubble behavior. The
    // list therefore holds at most one entry per dedupe key.
    const key = recentlyPlayedDedupeKey(entry);
    this.entries = this.entries.filter(
      (existing) => recentlyPlayedDedupeKey(existing) !== key
    );

    this.entries.unshift(entry);
    if (this.entries.length > this.cap) {
      this.entries.length = this.cap;
    }

    this.schedulePersist();
    this.emit("inserted", entry);
  }

  /**
   * Noise gate: returns true when a now-playing event is the SAME
   * ongoing play being re-reported, not a genuine (re)play.
   *
   * `now-playing-updated` fires on every `zones_changed` — pause,
   * resume, seek, volume, queue edit — not just track changes, so
   * the same track's event arrives many times during one play. We
   * suppress when ANY entry within the effective window has the same
   * dedupe key. Three cases this catches:
   *
   * 1. Same track re-emitted by Roon mid-play (seek, pause, metadata
   *    refresh). The window must be wide enough to span the whole
   *    track — Roon can re-emit minutes after the play started.
   * 2. Group-play artifacts: when zones are grouped, every grouped
   *    zone reports the same now_playing within milliseconds. Same
   *    dedupe key + tight time window = same play, regardless of
   *    zone. Trade-off: two zones that independently happen to play
   *    the same track within the window collapse to one entry —
   *    acceptable for "recently played" UX.
   * 3. Multi-zone interleaving: zone A plays track X, zone B plays
   *    track Y, then A re-emits X mid-play. Head is Y, but we still
   *    need to suppress against the prior X entry. A head-only check
   *    misses this. Solution: scan entries within the window.
   *
   * The window is `max(suppressionWindowMs, track_duration + grace)`.
   * The configured value (default 30s) is the floor for short tracks
   * or unknown duration. Entries are newest-first, so we stop the
   * scan as soon as we walk past the window edge.
   *
   * Past the window, a same-key event is treated as a genuine replay
   * — `handleNowPlaying` then bubbles it to the top rather than
   * suppressing. A quick restart *within* the window is suppressed
   * along with the noise; that's a deliberate trade-off, since
   * Roon's event stream gives us no way to tell a within-window
   * restart apart from a within-window re-emit.
   */
  private shouldSuppress(entry: RecentlyPlayedEntry): boolean {
    const entryTime = Date.parse(entry.played_at);
    if (!Number.isFinite(entryTime)) return false;
    const key = recentlyPlayedDedupeKey(entry);
    const durationMs = entry.duration ? entry.duration * 1000 : 0;
    const TRACK_END_GRACE_MS = 5_000;
    const window = Math.max(
      this.suppressionWindowMs,
      durationMs + TRACK_END_GRACE_MS
    );

    for (const existing of this.entries) {
      const existingTime = Date.parse(existing.played_at);
      if (!Number.isFinite(existingTime)) continue;
      // Entries are newest-first. Past the window edge → no more
      // candidates can match.
      if (entryTime - existingTime >= window) break;
      if (recentlyPlayedDedupeKey(existing) === key) return true;
    }
    return false;
  }

  // ── Persistence ───────────────────────────────────────────────────

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.logger.warn(
          { filePath: this.filePath },
          "RecentlyPlayedService: persisted file is not an array; starting empty"
        );
        this.entries = [];
        return;
      }
      // Dedupe on load: a file written before move-to-front dedup
      // existed can hold duplicates. Without this they'd surface via
      // /api/recently-played until each track happened to replay.
      this.entries = dedupeRecentlyPlayed(
        parsed.filter((it): it is RecentlyPlayedEntry => isPlausibleEntry(it))
      ).slice(0, this.cap);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // First run, no file yet. Quiet success.
        this.entries = [];
        return;
      }
      this.logger.warn(
        { err, filePath: this.filePath },
        "RecentlyPlayedService: failed to read persisted file; starting empty"
      );
      this.entries = [];
    }
  }

  /**
   * Queue a persist so concurrent inserts serialize. A failure is
   * logged but doesn't poison the chain — the next persist attempt
   * starts fresh with the current in-memory state, which is the
   * source of truth.
   */
  private schedulePersist(): void {
    void this.schedulePersistAsync();
  }

  /**
   * Like `schedulePersist` but returns a promise reflecting this
   * specific write's outcome — caller awaits to know when the write
   * is durable. The chain still swallows errors so a failed write
   * here doesn't poison the next queued one.
   */
  private schedulePersistAsync(): Promise<void> {
    const persistPromise = this.writeChain
      .catch(() => undefined)
      .then(() => this.persist());
    this.writeChain = persistPromise.catch(() => undefined);
    return persistPromise;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2), "utf-8");
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      this.logger.warn(
        { err, filePath: this.filePath },
        "RecentlyPlayedService: persist failed; in-memory list still authoritative"
      );
      // Best-effort cleanup of the tmp file. Don't propagate failures
      // here — we're already in an error path.
      void fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

function isPlausibleEntry(value: unknown): value is RecentlyPlayedEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.zone_id !== "string" || v.zone_id.length === 0) return false;
  if (typeof v.played_at !== "string" || v.played_at.length === 0) return false;
  if (v.title !== undefined && typeof v.title !== "string") return false;
  if (v.artist !== undefined && typeof v.artist !== "string") return false;
  if (v.album !== undefined && typeof v.album !== "string") return false;
  if (v.duration !== undefined && typeof v.duration !== "number") return false;
  if (v.image_key !== undefined && typeof v.image_key !== "string") return false;
  if (v.zone_name !== undefined && typeof v.zone_name !== "string") return false;
  return true;
}

