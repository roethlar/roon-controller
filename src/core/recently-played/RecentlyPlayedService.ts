import { EventEmitter } from "events";
import { promises as fs } from "fs";
import path from "path";
import { Logger } from "pino";
import type { NowPlaying, RecentlyPlayedEntry } from "../../shared/types";
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
 * Events:
 * - `inserted`: emitted only when a NEW entry is actually added to
 *   the list. Suppressed (dedupe-collapsed) updates do NOT emit.
 *   Listeners can use this to broadcast a socket update without
 *   spamming clients on seek/pause noise.
 */
export declare interface RecentlyPlayedService {
  on(event: "inserted", listener: (entry: RecentlyPlayedEntry) => void): this;
  emit(event: "inserted", entry: RecentlyPlayedEntry): boolean;
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

    this.entries.unshift(entry);
    if (this.entries.length > this.cap) {
      this.entries.length = this.cap;
    }

    this.schedulePersist();
    this.emit("inserted", entry);
  }

  /**
   * Suppress when the most-recent entry has the same dedupe key AND
   * was recorded within the effective window. Two cases this catches:
   *
   * 1. Same track re-emitted by Roon mid-play (seek, pause, metadata
   *    refresh). The window must be wide enough to span the whole
   *    track — Roon can re-emit minutes after the play started.
   * 2. Group-play artifacts: when zones are grouped, every grouped
   *    zone reports the same now_playing within milliseconds. We
   *    don't compare zone_id; same dedupe key + tight time window =
   *    same play, regardless of zone. Trade-off: two zones that
   *    independently happen to play the same track within the
   *    window collapse to one entry. Acceptable for "recently
   *    played" UX.
   *
   * The window is `max(suppressionWindowMs, track_duration + grace)`.
   * The configured value (default 30s) is the floor for short
   * tracks or unknown duration.
   */
  private shouldSuppress(entry: RecentlyPlayedEntry): boolean {
    const head = this.entries[0];
    if (!head) return false;
    if (this.dedupeKey(head) !== this.dedupeKey(entry)) return false;
    const headTime = Date.parse(head.played_at);
    const entryTime = Date.parse(entry.played_at);
    if (!Number.isFinite(headTime) || !Number.isFinite(entryTime)) return false;
    const durationMs = entry.duration ? entry.duration * 1000 : 0;
    const TRACK_END_GRACE_MS = 5_000;
    const window = Math.max(
      this.suppressionWindowMs,
      durationMs + TRACK_END_GRACE_MS
    );
    return entryTime - headTime < window;
  }

  private dedupeKey(entry: RecentlyPlayedEntry): string {
    return [
      entry.title ?? "",
      entry.artist ?? "",
      entry.album ?? "",
      entry.duration ?? "",
      entry.image_key ?? "",
    ].join("|");
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
      this.entries = parsed
        .filter((it): it is RecentlyPlayedEntry => isPlausibleEntry(it))
        .slice(0, this.cap);
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
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.persist());
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

