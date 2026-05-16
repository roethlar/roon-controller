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
  // Serializes async `handleNowPlayingImpl` calls so each insert's
  // snapshot → mutate → persist → emit/rollback runs atomically with
  // respect to the next. Without this chain, two now-playing events
  // arriving back-to-back would interleave their mutations across
  // await points, and a failed persist's rollback could clobber a
  // later successful insert.
  private insertChain: Promise<void> = Promise.resolve();
  private nowPlayingHandler?: (data: {
    zone_id: string;
    now_playing: NowPlaying;
  }) => void;
  private zoneNameLookup: (zoneId: string) => string | undefined = () =>
    undefined;
  // Linearization for clear(): while a clear is awaiting persist,
  // incoming now-playing events are buffered (not mutated into
  // `this.entries` and not broadcast). After clear resolves we drain
  // the buffer through the normal handler. This guarantees the
  // observed broadcast order is `cleared` then any post-clear
  // `inserted`s, and that clear's persist writes the truly-empty
  // list rather than a list a concurrent insert mutated mid-await.
  private clearInFlight = false;
  private pendingDuringClear: Array<{
    zoneId: string;
    nowPlaying: NowPlaying;
  }> = [];
  // Coalescing handle for overlapping clear() callers (e.g. two
  // simultaneous DELETEs from different clients). All callers share
  // one in-flight operation, so there's a single persist, a single
  // `cleared` broadcast, and a single drain — never a second clear
  // resetting state mid-drain of the first.
  private pendingClear: Promise<void> | null = null;
  // Monotonic revision counter. Bumped on every state change (insert
  // / clear). Clients track the highest revision they've applied and
  // discard anything not strictly newer, which closes a family of
  // races where socket events and REST responses arrive out of
  // server-emit order. Per-process — a restart resets to 0.
  //
  // The accompanying `epoch` is a STRICTLY MONOTONIC generation
  // persisted alongside entries on disk and incremented on every
  // service start. Clients treat `payload.epoch > lastAppliedEpoch`
  // as "new authority, adopt"; older or equal epochs from the same
  // server are bound by revision. A monotonic-and-persisted source
  // is needed because Date.now() can repeat (same-ms restart, clock
  // adjustment, container snapshot rollback), and correctness
  // depends on epoch ordering being trustworthy.
  private revision = 0;
  private epoch = 0;
  // Memoized so start() is idempotent — repeated calls return the
  // same promise instead of re-running loadFromDisk (which would
  // bump generation and reload disk over the live in-memory state).
  private startPromise: Promise<void> | null = null;
  // Bumped on every stop(). doStart captures the token before its
  // first await and rechecks after — if it changed, a stop landed
  // mid-startup and the run must NOT attach a listener (the caller
  // already wants the service torn down).
  private startToken = 0;
  // Set when the eager generation persist at startup fails. The
  // service is "running" but its epoch hasn't been committed to
  // disk; if we kept serving, a restart could reuse the same epoch
  // and clients with prior state would reject new events as stale.
  // Routes/socket emits gate on this so the failure is visible
  // (503 / no broadcast) instead of silent corruption.
  private degraded = false;
  // Most recent persist failure, if any — for /api/health
  // diagnostics. Cleared on next successful persist. Doesn't gate
  // routes (degraded does that); this is purely operator-facing.
  private lastPersistError: { message: string; ts: string } | undefined;

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
   * now-playing-updated events. Idempotent: repeated calls return the
   * same promise — important now that `loadFromDisk` bumps + persists
   * the generation, which would otherwise advance the epoch every
   * call AND reload disk over current in-memory state.
   */
  public start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const myToken = ++this.startToken;
    // Optimistically clear degraded so a stop()+start() cycle can
    // recover after an admin fixes the file. If the new read still
    // fails, we'll set it back below. (Within a single in-flight
    // start, this assignment is fine — readFromDisk is pure and
    // can't observe it.)
    this.degraded = false;

    // PURE read — no mutation, no persist. Side effects deferred
    // until after the cancellation check so a stop+start during the
    // file read doesn't burn a generation or write entries that the
    // caller has already given up on.
    const loaded = await this.readFromDisk();

    // Cancellation check: stop() (or stop+start) during the read
    // bumped the token. Discard the result entirely — don't apply
    // entries, don't bump epoch, don't persist, don't attach. The
    // follow-up start (already chained behind this one or running
    // concurrently in a later tick) is the effective restart.
    if (myToken !== this.startToken) return;

    this.entries = loaded.entries;

    if (loaded.degradedReason) {
      // Persisted state is untrusted (corrupt file, bad shape,
      // missing/invalid generation, read error). Don't bump epoch,
      // don't persist (would overwrite the unreadable file with our
      // empty view), don't attach the listener (would let inserts
      // mutate + persist the same way).
      this.degraded = true;
      return;
    }

    // Monotonic-and-persisted epoch: bump from the read generation
    // and commit before exposing the new epoch via the listener.
    // Eager-persist failure = degraded (uncommitted epoch would let
    // a future restart reuse it).
    this.epoch = loaded.generation + 1;
    try {
      await this.schedulePersistAsync();
    } catch (err) {
      this.degraded = true;
      this.logger.warn(
        { err, filePath: this.filePath },
        "RecentlyPlayedService: eager generation persist failed — entering degraded mode (routes will 503, broadcasts suppressed)"
      );
      return;
    }

    // Recheck after the eager persist's await. A stop() during that
    // await must also cancel the listener attach.
    if (myToken !== this.startToken) return;

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

  /**
   * Detach the now-playing listener and clear the start memo so a
   * subsequent `start()` can fully reinitialize (re-load from disk,
   * re-bump the generation, re-attach the listener). A repeated
   * start without an intervening stop is still idempotent.
   * Idempotent itself: stop() on a never-started or already-stopped
   * service is a no-op.
   */
  public stop(): void {
    if (this.nowPlayingHandler) {
      this.transportService.off("now-playing-updated", this.nowPlayingHandler);
      this.nowPlayingHandler = undefined;
    }
    this.startPromise = null;
    // Invalidate any doStart still in flight so it skips its
    // listener attach when it resumes.
    this.startToken++;
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

  /** Current monotonic revision — bumped on every state change. */
  public getRevision(): number {
    return this.revision;
  }

  /** Per-process identifier; lets clients detect a server restart. */
  public getEpoch(): number {
    return this.epoch;
  }

  /**
   * True when the service can't safely sync state with clients.
   * Triggers: corrupt JSON, missing/invalid `entries`, missing or
   * malformed `generation`, non-ENOENT read failure, or eager-persist
   * failure at startup. In any of these cases the persisted epoch is
   * either unknown or uncommitted, so serving would risk an epoch
   * repeat / reset and clients carrying a higher lastApplied epoch
   * from a prior boot would reject our events as stale.
   *
   * In degraded mode the service does NOT ingest now-playing events
   * (listener not attached) and `clear()` rejects, so the corrupt
   * file is left untouched for inspection / restore. Routes return
   * 503; socket broadcasts are suppressed in server.ts. Recovery:
   * fix the file, then `stop()` + `start()` re-attempts a clean
   * load (in-process recovery), or restart the process.
   */
  public isDegraded(): boolean {
    return this.degraded;
  }

   * Most recent persist failure, if any — for /api/health
   * diagnostics. Undefined when the last persist succeeded (or no
   * persist has been attempted yet). Doesn't gate route behavior;
   * `isDegraded()` is the authoritative readiness signal.
   */
  public getLastPersistError(): { message: string; ts: string } | undefined {
    return this.lastPersistError;
  }

  /**
   * Wait for the insert + write chains to settle.
   *
   * Inserts are queued onto `insertChain` and serialized through
   * `writeChain`, so the observable effect of a `fireNowPlaying`
   * event lags by at least one async tick. Tests and HTTP request
   * handlers that need to observe the result (or the lack of one,
   * after a rolled-back failure) await this method.
   *
   * Production code generally shouldn't need this — the event-emit
   * model is fire-and-forget — but the route layer can call it
   * before reading state if a particular response must reflect the
   * latest insert.
   */
  public async flush(): Promise<void> {
    await this.insertChain.catch(() => undefined);
    await this.writeChain.catch(() => undefined);
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
  public clear(): Promise<void> {
    // Refuse when degraded. The HTTP route already guards DELETE
    // and 503s, but the invariant belongs in the service too — a
    // future internal caller (or a misuse from elsewhere in the
    // process) would otherwise mutate entries + runClear's persist
    // would overwrite the corrupt-but-preserved file with
    // { entries: [], generation: <uncommitted> }, undoing the
    // "leave it alone" guarantee that degraded mode provides.
    if (this.degraded) {
      return Promise.reject(
        new Error("RecentlyPlayedService is degraded; clear() refused")
      );
    }
    // Overlapping callers share one in-flight operation. Without
    // this, a second clear's persist could complete after the
    // first's drain ran, broadcasting `cleared` after a post-drain
    // `inserted` and leaving clients out of sync with server/disk.
    if (this.pendingClear) {
      return this.pendingClear;
    }
    this.pendingClear = this.runClear();
    return this.pendingClear;
  }

  private async runClear(): Promise<void> {
    const previous = this.entries;
    const previousRevision = this.revision;
    this.entries = [];
    this.revision++;
    // Defer concurrent inserts until we resolve. Without this, a
    // now-playing event arriving during the persist await would mutate
    // `this.entries`, get its own `inserted` broadcast before
    // `cleared`, and leave clients/server divergent.
    this.clearInFlight = true;
    let persistError: Error | undefined;
    try {
      await this.schedulePersistAsync();
    } catch (err) {
      persistError = err instanceof Error ? err : new Error(String(err));
      this.entries = previous;
      this.revision = previousRevision;
    }

    // State reset MUST run regardless of what listeners do — a
    // throwing `cleared` or `inserted` listener (or our own emit)
    // shouldn't leave clearInFlight stuck true and pendingClear
    // pinned to a rejected promise. Without this, future inserts
    // buffer forever and future clears coalesce into the dead op.
    try {
      if (!persistError) {
        try {
          this.emit("cleared");
        } catch (err) {
          this.logger.warn(
            { err },
            "RecentlyPlayedService: 'cleared' listener threw; broadcast may be incomplete"
          );
        }
      }
    } finally {
      this.clearInFlight = false;
      // Reset pendingClear BEFORE drain, so a clear triggered from an
      // `inserted` listener during drain starts a fresh operation
      // rather than coalescing into the about-to-finish one.
      this.pendingClear = null;
      // Drain through the normal handler. On success the buffer
      // drains into the post-clear empty list (so `inserted` lands
      // after `cleared`); on failure it drains into the rolled-back
      // list (events that arrived weren't broadcast and shouldn't
      // be lost). drainPendingInserts already wraps each call.
      this.drainPendingInserts();
    }

    if (persistError) {
      throw persistError;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Entry point from the transport-service listener. If a clear is
   * mid-flight, buffer the event so it can be applied AFTER `cleared`
   * has been broadcast and the persist has committed; otherwise
   * enqueue onto the insert chain so it runs serially with prior
   * inserts (each one's persist completes before the next starts).
   *
   * Listener callbacks are sync, so we don't await the chain here —
   * but the chain itself owns the ordering guarantee.
   */
  private handleNowPlaying(zoneId: string, nowPlaying: NowPlaying | null): void {
    if (this.clearInFlight && nowPlaying) {
      this.pendingDuringClear.push({ zoneId, nowPlaying });
      return;
    }
    this.enqueueInsert(zoneId, nowPlaying);
  }

  private enqueueInsert(zoneId: string, nowPlaying: NowPlaying | null): void {
    this.insertChain = this.insertChain
      .catch(() => undefined)
      .then(() => this.handleNowPlayingImpl(zoneId, nowPlaying))
      .catch((err) => {
        this.logger.warn(
          { err },
          "RecentlyPlayedService: insert handler crashed; entry skipped"
        );
      });
  }

  /** Drain buffered events through the normal insert chain. */
  private drainPendingInserts(): void {
    const drained = this.pendingDuringClear;
    this.pendingDuringClear = [];
    for (const { zoneId, nowPlaying } of drained) {
      this.enqueueInsert(zoneId, nowPlaying);
    }
  }

  /**
   * Insert path. Mutates `this.entries` + `this.revision`, awaits
   * the persist, then emits `inserted` ONLY if the write committed.
   * On persist failure, rolls back to the pre-mutation snapshot —
   * clients are never told about an entry that won't survive a
   * restart. Serialized via `insertChain` (see `enqueueInsert`) so
   * the snapshot/mutate/persist/rollback sequence is atomic relative
   * to other inserts.
   *
   * M-3: prior to this change, `schedulePersist` was fire-and-forget
   * and `inserted` was emitted immediately. A post-startup persist
   * failure (disk full, permission flip) would broadcast revisions
   * the file never received; a restart would revert to the older
   * file while `/health` still reported OK.
   */
  private async handleNowPlayingImpl(
    zoneId: string,
    nowPlaying: NowPlaying | null
  ): Promise<void> {
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

    // Snapshot BEFORE mutating so a failed persist can roll back to
    // the exact prior state. Array reference is safe to keep — we
    // replace `this.entries` with a new array below rather than
    // mutating in place.
    const previousEntries = this.entries;
    const previousRevision = this.revision;

    // Not suppressed → either a brand-new track or a genuine replay
    // (same track, but the prior entry is outside the noise window).
    // Drop any prior occurrence so a replay bubbles to the top
    // instead of duplicating. `filter` (not splice-one) also cleans
    // up any legacy duplicates left by the pre-bubble behavior. The
    // list therefore holds at most one entry per dedupe key.
    const key = recentlyPlayedDedupeKey(entry);
    const next = [
      entry,
      ...this.entries.filter(
        (existing) => recentlyPlayedDedupeKey(existing) !== key
      ),
    ];
    if (next.length > this.cap) {
      next.length = this.cap;
    }

    this.entries = next;
    this.revision++;

    try {
      await this.schedulePersistAsync();
    } catch (err) {
      // Roll back so the in-memory list matches the file and clients
      // never see a phantom revision. Drop the broadcast.
      this.entries = previousEntries;
      this.revision = previousRevision;
      this.logger.warn(
        { err, entry: { title: entry.title, zone_id: entry.zone_id } },
        "RecentlyPlayedService: insert persist failed; rolled back in-memory state and suppressed 'inserted' broadcast"
      );
      return;
    }

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

  /**
   * Read + parse the persisted file. PURE — no instance state is
   * mutated, no persist is scheduled. doStart calls this, then
   * applies the result (or discards it on cancellation) so a
   * cancelled startup can't leak side effects into a follow-up run.
   */
  private async readFromDisk(): Promise<{
    entries: RecentlyPlayedEntry[];
    generation: number;
    degradedReason: string | undefined;
  }> {
    let rawEntries: unknown[] = [];
    let persistedGeneration = 0;
    let degradedReason: string | undefined;

    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Corrupt JSON: we can't recover the previous generation.
        // Reset would let clients with higher lastApplied reject our
        // events as stale (or reuse an epoch). Degrade — the file
        // stays untouched for inspection / restore.
        degradedReason = `JSON parse failure (${(err as Error).message})`;
      }
      if (parsed !== undefined) {
        if (Array.isArray(parsed)) {
          // Legacy bare-array format (pre-generation tracking).
          // generation == 0 is correct — nothing was ever committed.
          rawEntries = parsed;
        } else if (parsed && typeof parsed === "object") {
          const obj = parsed as { entries?: unknown; generation?: unknown };
          // Strict generation validation: non-negative safe integer
          // only. Coercing floats with Math.floor or clamping
          // negatives to 0 would silently move epoch backward.
          const generationValid =
            typeof obj.generation === "number" &&
            Number.isSafeInteger(obj.generation) &&
            obj.generation >= 0;
          // Preserve generation if valid, even when entries are
          // missing — lets a follow-up clean run keep the chain.
          if (generationValid) {
            persistedGeneration = obj.generation as number;
          }
          if (!Array.isArray(obj.entries)) {
            degradedReason = "missing or invalid `entries` array";
          } else if (!generationValid) {
            degradedReason = "missing or invalid `generation` field";
            rawEntries = obj.entries;
          } else {
            rawEntries = obj.entries;
          }
        } else {
          degradedReason = "persisted shape is neither array nor object";
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // ENOENT is a legit first run. Other read errors (permission,
        // I/O) leave us unable to know the previous generation —
        // degrade rather than risk an epoch reset.
        degradedReason = `file read failure (${code ?? "unknown"})`;
      }
    }

    if (degradedReason) {
      this.logger.warn(
        { reason: degradedReason, filePath: this.filePath },
        "RecentlyPlayedService: persisted state unreadable — entering degraded mode (routes will 503, broadcasts suppressed)"
      );
    }

    // Dedupe on load: a file written before move-to-front dedup
    // existed can hold duplicates. Without this they'd surface via
    // /api/recently-played until each track happened to replay.
    const entries = dedupeRecentlyPlayed(
      rawEntries.filter((it): it is RecentlyPlayedEntry => isPlausibleEntry(it))
    ).slice(0, this.cap);

    return {
      entries,
      generation: persistedGeneration,
      degradedReason,
    };
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
    // Persist `generation` alongside entries so the epoch survives
    // restarts (and never repeats — see loadFromDisk for the bump).
    const payload = JSON.stringify(
      { entries: this.entries, generation: this.epoch },
      null,
      2
    );
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, payload, "utf-8");
      await fs.rename(tmp, this.filePath);
      // Successful persist clears any prior diagnostic so /api/health
      // doesn't keep reporting a stale failure forever.
      this.lastPersistError = undefined;
    } catch (err) {
      this.lastPersistError = {
        message: err instanceof Error ? err.message : String(err),
        ts: new Date(this.now()).toISOString(),
      };
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

