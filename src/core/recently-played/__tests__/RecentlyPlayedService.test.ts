import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import { Logger } from "pino";
import { RecentlyPlayedService } from "../RecentlyPlayedService";
import type { TransportService } from "../../roon/TransportService";
import type { NowPlaying } from "../../../shared/types";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

class FakeTransport extends EventEmitter {
  fireNowPlaying(zoneId: string, nowPlaying: NowPlaying | null): void {
    this.emit("now-playing-updated", { zone_id: zoneId, now_playing: nowPlaying });
  }
}

function nowPlaying(over: Partial<NowPlaying> = {}): NowPlaying {
  return {
    zone_id: "zone-a",
    title: "Track",
    artist: "Artist",
    album: "Album",
    duration: 180,
    image_key: "img-1",
    state: "playing",
    ...over,
  };
}

async function makeTmpPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recently-played-"));
  return path.join(dir, "recently-played.json");
}

async function readPersisted(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  // The service now writes `{ entries, generation }` but legacy
  // tests asserted against a bare array. Unwrap so the array
  // assertions still apply; tests that care about generation read
  // the raw file via readPersistedRaw.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.entries)) {
    return parsed.entries;
  }
  return parsed;
}

async function readPersistedRaw(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function flushWrites(svc: RecentlyPlayedService): Promise<void> {
  // The service serializes writes onto an internal chain. Awaiting
  // the chain itself isn't exposed; flush by issuing a no-op tick.
  // In practice, the chain settles within microtasks once nothing
  // new is queued — `await Promise.resolve()` twice is enough to
  // observe rename completion.
  await Promise.resolve();
  await Promise.resolve();
  // One filesystem round-trip:
  await new Promise((r) => setTimeout(r, 5));
  void svc;
}

describe("RecentlyPlayedService", () => {
  describe("dedupe + suppression window", () => {
    it("inserts the first entry from a now-playing event", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000 }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Hey Jude" }));

      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].title).toBe("Hey Jude");
      expect(inserts).toHaveLength(1);
    });

    it("collapses duplicate now-playing events within the suppression window", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      const np = nowPlaying({ title: "Hey Jude" });
      transport.fireNowPlaying("zone-a", np);
      clock += 5_000; // 5s later, well under the 30s window
      transport.fireNowPlaying("zone-a", np);
      clock += 10_000; // 15s total
      transport.fireNowPlaying("zone-a", np);

      expect(svc.getEntries()).toHaveLength(1);
      expect(inserts).toHaveLength(1);
    });

    it("bubbles a replay to the top once the suppression window has passed", async () => {
      // Use duration: 0 so the effective window is just the
      // configured 30s floor; otherwise duration would dominate.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      const np = nowPlaying({ title: "Hey Jude", duration: 0 });
      transport.fireNowPlaying("zone-a", np);
      const firstPlayedAt = svc.getEntries()[0].played_at;
      clock += 31_000; // past the 30s window (duration is 0)
      transport.fireNowPlaying("zone-a", np);

      // Replay bubbles in place: one entry, fresh played_at, and the
      // bubble re-emits `inserted` so the socket broadcast fires.
      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].played_at).not.toBe(firstPlayedAt);
      expect(inserts).toHaveLength(2);
    });

    it("collapses cross-zone duplicates within the window (group play)", async () => {
      // Grouped zones playing the same track produce a now-playing
      // event per zone within milliseconds. We collapse them to one
      // entry — same dedupe key + within window = same play, even
      // across zones. Trade-off: two zones independently playing the
      // same track within the window collapse too. Acceptable for
      // "recently played" UX.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const np = nowPlaying({ title: "Hey Jude", duration: 200 });
      transport.fireNowPlaying("zone-a", { ...np, zone_id: "zone-a" });
      clock += 5; // 5ms later — group-play emit
      transport.fireNowPlaying("zone-b", { ...np, zone_id: "zone-b" });

      expect(svc.getEntries()).toHaveLength(1);
    });

    it("uses track duration as the window so mid-play re-emits get suppressed", async () => {
      // Roon can re-emit the same now_playing well after the start of
      // a track (queue-changed, metadata refresh). Without using the
      // track's own duration as the window floor, a 4-minute track
      // re-emitted at 2 minutes slips past the 30s default and
      // duplicates.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const np = nowPlaying({ title: "Alexander Hamilton", duration: 236 });
      transport.fireNowPlaying("zone-a", np);
      clock += 107_000; // 107s in — past 30s default, well within song
      transport.fireNowPlaying("zone-a", np);

      expect(svc.getEntries()).toHaveLength(1);
    });

    it("dedupes against any prior entry within the window, not just head (multi-zone interleaving)", async () => {
      // Zone A starts X, zone B starts Y, then zone A re-emits X
      // mid-play. Head when X re-emits is Y, but the suppression
      // check must also see the earlier X within the window.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const trackX = nowPlaying({ title: "Track X", duration: 200 });
      const trackY = nowPlaying({
        title: "Track Y",
        duration: 200,
        zone_id: "zone-b"
      });

      transport.fireNowPlaying("zone-a", trackX);
      clock += 2_000;
      transport.fireNowPlaying("zone-b", trackY);
      clock += 5_000; // 7s after X started — well within X's 200s window
      transport.fireNowPlaying("zone-a", trackX); // mid-play re-emit

      // Two distinct tracks recorded; the X re-emit was suppressed
      // even though head was Y.
      const titles = svc.getEntries().map((e) => e.title);
      expect(titles).toEqual(["Track Y", "Track X"]);
    });

    it("bubbles a replay to the top once the track-duration window has passed", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const np = nowPlaying({ title: "Short Song", duration: 60 });
      transport.fireNowPlaying("zone-a", np);
      clock += 70_000; // past duration + grace (5s) — legitimate replay
      transport.fireNowPlaying("zone-a", np);

      // Legitimate replay → bubble, not duplicate.
      expect(svc.getEntries()).toHaveLength(1);
    });

    it("bubbles a replayed track over later plays instead of duplicating", async () => {
      // The user-reported bug: play A, play another track, play A
      // again — A duplicated instead of moving to the top. With
      // move-to-front dedup the prior A is removed and a fresh A
      // unshifted, so the list holds at most one entry per track.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const trackA = nowPlaying({ title: "Track A", duration: 60 });
      const trackB = nowPlaying({ title: "Track B", duration: 60 });

      transport.fireNowPlaying("zone-a", trackA);
      clock += 1_000;
      transport.fireNowPlaying("zone-a", trackB);
      clock += 70_000; // past Track A's 65s window
      transport.fireNowPlaying("zone-a", trackA); // genuine replay

      expect(svc.getEntries().map((e) => e.title)).toEqual([
        "Track A",
        "Track B",
      ]);
    });

    it("ignores null now_playing payloads (zone went idle)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", null);
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "" }));

      expect(svc.getEntries()).toHaveLength(0);
    });

    it("only emits `inserted` for new entries (not for suppressed duplicates)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000 }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" })); // dup
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "B" }));

      expect(inserts).toHaveLength(2);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["B", "A"]);
    });
  });

  describe("clear()", () => {
    it("awaits persist before resolving and emits `cleared` once durable", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      let clearedCount = 0;
      svc.on("cleared", () => clearedCount++);
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      transport.fireNowPlaying("zone-b", nowPlaying({ title: "B", zone_id: "zone-b" }));
      expect(svc.getEntries()).toHaveLength(2);

      await svc.clear();

      // By the time the await resolves: in-memory empty, file empty,
      // and `cleared` already emitted (which drives the socket
      // broadcast).
      expect(svc.getEntries()).toEqual([]);
      expect(await readPersisted(filePath)).toEqual([]);
      expect(clearedCount).toBe(1);
    });

    it("clear() on an already-empty list still emits (idempotent across clients)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      let clearedCount = 0;
      svc.on("cleared", () => clearedCount++);
      await svc.start();

      await svc.clear();

      expect(svc.getEntries()).toEqual([]);
      expect(clearedCount).toBe(1);
    });

    it("buffers a concurrent insert and broadcasts cleared before inserted", async () => {
      // The race the reviewer flagged: a now-playing event arrives
      // between clear()'s synchronous in-memory wipe and its awaited
      // persist. Without buffering, the insert mutates the array
      // back to [entry], the persist serializes that array (so disk
      // ends up non-empty), and clients receive `inserted` then
      // `cleared` — leaving them empty while server/disk still hold
      // the entry.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      // Don't await yet — clear's synchronous prelude runs (entries
      // emptied, clearInFlight=true), then the persist await yields.
      const clearPromise = svc.clear();
      // Now-playing arrives mid-await. Should be buffered, NOT
      // mutate entries and NOT emit `inserted` yet.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "MidClear" }));
      expect(svc.getEntries()).toEqual([]);
      expect(events).toEqual([]);

      await clearPromise;

      // After clear: cleared emitted first, then the buffered insert
      // drained through the normal handler → inserted emitted with
      // the entry.
      expect(events).toEqual(["cleared", "inserted:MidClear"]);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["MidClear"]);

      // Disk converges with in-memory: clear's persist wrote [], then
      // the drained insert's persist wrote [MidClear].
      await flushWrites(svc);
      const persisted = (await readPersisted(filePath)) as Array<{ title: string }>;
      expect(persisted.map((e) => e.title)).toEqual(["MidClear"]);
    });

    it("drains buffered inserts onto the rolled-back list when persist fails", async () => {
      // Failure path of the same race: a now-playing event arrives
      // during a clear that ultimately fails to persist. Rollback
      // restores the prior list, the drained insert applies on top,
      // and `cleared` is NOT broadcast (clients shouldn't see a
      // wipe that didn't survive).
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rp-race-fail-"));
      const blocker = path.join(tmpdir, "blocker");
      await fs.writeFile(blocker, "");
      const badPath = path.join(blocker, "recently-played.json");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath: badPath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Before" }));
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Before"]);

      const clearPromise = svc.clear();
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "MidClear" }));
      await expect(clearPromise).rejects.toThrow();

      // No cleared broadcast on failure.
      expect(events).toEqual(["inserted:Before", "inserted:MidClear"]);
      // Rolled back + buffered insert applied on top.
      expect(svc.getEntries().map((e) => e.title)).toEqual([
        "MidClear",
        "Before",
      ]);
    });

    it("coalesces overlapping clear() calls into one persist + one cleared broadcast", async () => {
      // Two clients hitting DELETE simultaneously must not produce
      // two interleaved clear operations. Without coalescing, the
      // second clear's late `cleared` broadcast can land after the
      // first clear's drained `inserted`, leaving clients empty
      // while server/disk hold the entry.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Before" }));
      events.length = 0; // ignore the seed insert

      const a = svc.clear();
      const b = svc.clear();

      // Same in-flight operation, returned to both callers.
      expect(a).toBe(b);

      await Promise.all([a, b]);

      // Single cleared broadcast — no late broadcast from a second
      // operation finishing later.
      expect(events).toEqual(["cleared"]);
      expect(svc.getEntries()).toEqual([]);
    });

    it("overlapping clears + concurrent insert: one cleared broadcast, deferred insert after", async () => {
      // The exact divergence the reviewer flagged: while two clears
      // overlap, a now-playing event arrives. Coalescing means the
      // single drain runs once; the insert lands AFTER the single
      // `cleared` broadcast. Server, disk, and clients converge.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      const a = svc.clear();
      const b = svc.clear();
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "MidClear" }));
      await Promise.all([a, b]);

      expect(events).toEqual(["cleared", "inserted:MidClear"]);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["MidClear"]);

      // Disk converges with in-memory.
      await flushWrites(svc);
      const persisted = (await readPersisted(filePath)) as Array<{ title: string }>;
      expect(persisted.map((e) => e.title)).toEqual(["MidClear"]);
    });

    it("does not wedge service state when a 'cleared' listener throws", async () => {
      // EventEmitter listener exceptions propagate synchronously
      // back to emit()'s caller. Without isolation, a throwing
      // listener would skip the post-emit state reset
      // (clearInFlight stays true, pendingClear stays pinned to a
      // rejected promise) — future inserts buffer forever, future
      // clear() calls coalesce to the dead promise.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      svc.on("cleared", () => {
        throw new Error("listener boom");
      });
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      expect(svc.getEntries()).toHaveLength(1);

      // First clear: listener throws; the service swallows it,
      // resets state, and resolves cleanly.
      await expect(svc.clear()).resolves.toBeUndefined();
      expect(svc.getEntries()).toEqual([]);

      // Subsequent insert lands normally — proves clearInFlight
      // was reset (otherwise the event would be buffered, not
      // applied to entries).
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "B" }));
      expect(svc.getEntries().map((e) => e.title)).toEqual(["B"]);

      // Subsequent clear works — proves pendingClear was reset
      // (otherwise this would await the prior op's settled promise
      // and never run a fresh clear).
      await expect(svc.clear()).resolves.toBeUndefined();
      expect(svc.getEntries()).toEqual([]);
    });

    it("rejects and rolls back the in-memory list when persist fails", async () => {
      // Construct an unwritable file path: a directory component
      // points at a regular file, so mkdir(recursive) fails with
      // ENOTDIR. Reproduces a real failure (disk full, permission
      // error) without platform-specific mocking.
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rp-fail-"));
      const blocker = path.join(tmpdir, "blocker");
      await fs.writeFile(blocker, "");
      const badPath = path.join(blocker, "recently-played.json");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath: badPath }
      );
      let clearedCount = 0;
      svc.on("cleared", () => clearedCount++);
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Stays" }));
      expect(svc.getEntries()).toHaveLength(1);

      await expect(svc.clear()).rejects.toThrow();

      // Rolled back: the in-memory list matches what's still on disk
      // (or would be, if disk were writable). `cleared` was NOT
      // emitted — clients don't see a broadcast they'd then disagree
      // with after restart.
      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].title).toBe("Stays");
      expect(clearedCount).toBe(0);
    });
  });

  describe("cap enforcement", () => {
    it("keeps only the most recent N entries", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, cap: 3, suppressionWindowMs: 0 }
      );
      await svc.start();

      for (let i = 0; i < 5; i++) {
        transport.fireNowPlaying(
          "zone-a",
          nowPlaying({ title: `Track ${i}` })
        );
      }

      expect(svc.getEntries()).toHaveLength(3);
      expect(svc.getEntries().map((e) => e.title)).toEqual([
        "Track 4",
        "Track 3",
        "Track 2",
      ]);
    });
  });

  describe("persistence + recovery", () => {
    it("loads previously-persisted entries on start", async () => {
      const filePath = await makeTmpPath();
      const seed = [
        {
          title: "Old",
          zone_id: "zone-a",
          played_at: new Date().toISOString(),
        },
      ];
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(seed), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].title).toBe("Old");
    });

    it("persists new entries to disk via atomic write (tmp + rename)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      await flushWrites(svc);

      const persisted = (await readPersisted(filePath)) as Array<{
        title: string;
      }>;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].title).toBe("A");

      // No leftover .tmp file.
      await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
    });

    it("recovers from corrupt JSON on disk (starts empty, doesn't throw)", async () => {
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{ not json", "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toEqual([]);

      // Service still works after recovery.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      expect(svc.getEntries()).toHaveLength(1);
    });

    it("recovers when persisted JSON is the wrong shape (not an array)", async () => {
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ entries: [] }), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toEqual([]);
    });

    it("dedupes legacy duplicates from the persisted file on load", async () => {
      // A file written before move-to-front dedup can hold the same
      // track twice. loadFromDisk must collapse it, keeping the
      // newest (first) occurrence — otherwise the duplicate surfaces
      // via /api/recently-played until that track happens to replay.
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const seed = [
        {
          title: "A",
          artist: "Artist",
          album: "Album",
          duration: 180,
          image_key: "img",
          zone_id: "z1",
          played_at: "2026-05-14T03:00:00.000Z",
        },
        {
          title: "B",
          zone_id: "z1",
          played_at: "2026-05-14T02:00:00.000Z",
        },
        {
          title: "A",
          artist: "Artist",
          album: "Album",
          duration: 180,
          image_key: "img",
          zone_id: "z1",
          played_at: "2026-05-14T01:00:00.000Z",
        },
      ];
      await fs.writeFile(filePath, JSON.stringify(seed), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries().map((e) => e.title)).toEqual(["A", "B"]);
      expect(svc.getEntries()[0].played_at).toBe("2026-05-14T03:00:00.000Z");
    });

    it("increments + persists the generation on each start (monotonic epoch source)", async () => {
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();

      // First start: file doesn't exist → generation starts at 0 →
      // epoch = 1, persisted immediately.
      const svc1 = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc1.start();
      expect(svc1.getEpoch()).toBe(1);

      const raw1 = (await readPersistedRaw(filePath)) as {
        entries: unknown[];
        generation: number;
      };
      expect(raw1.generation).toBe(1);
      expect(raw1.entries).toEqual([]);

      // Second start (simulating a restart): loads generation=1,
      // bumps to epoch=2, persists.
      const svc2 = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc2.start();
      expect(svc2.getEpoch()).toBe(2);

      const raw2 = (await readPersistedRaw(filePath)) as { generation: number };
      expect(raw2.generation).toBe(2);
    });

    it("migrates a legacy bare-array file to the new {entries, generation} shape", async () => {
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const legacy = [
        {
          title: "Hey Jude",
          zone_id: "zone-a",
          played_at: "2026-05-08T00:00:00.000Z",
        },
      ];
      await fs.writeFile(filePath, JSON.stringify(legacy), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      // Entries survived migration; epoch starts at 1 (legacy file had
      // no persisted generation, so we treat it as 0).
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Hey Jude"]);
      expect(svc.getEpoch()).toBe(1);

      // File is now in the new shape.
      const raw = (await readPersistedRaw(filePath)) as Record<string, unknown>;
      expect(Array.isArray(raw)).toBe(false);
      expect(Array.isArray(raw.entries)).toBe(true);
      expect(raw.generation).toBe(1);
    });

    it("filters out implausible entries when loading", async () => {
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const mixed = [
        { title: "Good", zone_id: "z1", played_at: new Date().toISOString() },
        { title: "Bad — no zone_id", played_at: new Date().toISOString() },
        { duration: "not a number", zone_id: "z1", played_at: new Date().toISOString() },
        null,
        "not even an object",
      ];
      await fs.writeFile(filePath, JSON.stringify(mixed), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].title).toBe("Good");
    });

    it("first-run empty file path doesn't throw (ENOENT is graceful)", async () => {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rp-"));
      const filePath = path.join(tmpdir, "nope-not-yet.json");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toEqual([]);
    });
  });

  describe("zone-name lookup", () => {
    it("stamps the zone display name onto each entry at insert time", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      svc.setZoneNameLookup((zoneId) =>
        zoneId === "zone-a" ? "Living Room" : undefined
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      transport.fireNowPlaying("zone-b", nowPlaying({ title: "B", zone_id: "zone-b" }));

      const entries = svc.getEntries();
      expect(entries[1].zone_name).toBe("Living Room");
      expect(entries[0].zone_name).toBeUndefined();
    });
  });

  describe("stop()", () => {
    it("detaches the now-playing listener", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Before" }));
      svc.stop();
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "After" }));

      expect(svc.getEntries().map((e) => e.title)).toEqual(["Before"]);
    });
  });
});
