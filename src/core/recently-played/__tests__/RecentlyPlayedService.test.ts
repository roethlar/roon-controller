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

    it("inserts a fresh entry once the suppression window has passed", async () => {
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
      await svc.start();

      const np = nowPlaying({ title: "Hey Jude", duration: 0 });
      transport.fireNowPlaying("zone-a", np);
      clock += 31_000; // past the 30s window (duration is 0)
      transport.fireNowPlaying("zone-a", np);

      expect(svc.getEntries()).toHaveLength(2);
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

    it("inserts a new entry once the track-duration window has passed (legitimate replay)", async () => {
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

      expect(svc.getEntries()).toHaveLength(2);
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
