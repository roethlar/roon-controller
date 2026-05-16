import http from 'http';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { AddressInfo } from 'net';
import { createHttpApp } from '../app';
import { RoonClient } from '../../../core/roon/RoonClient';
import { TransportService } from '../../../core/roon/TransportService';
import { BrowseService } from '../../../core/roon/BrowseService';
import { ImageService } from '../../../core/roon/ImageService';
import { RecentlyPlayedService } from '../../../core/recently-played/RecentlyPlayedService';

const stubLogger: any = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: 'info',
};

const stubRoon: any = {
  getCoreStatus: () => 'discovering',
  getCoreInfo: () => null,
  getTransport: () => null,
  getBrowse: () => null,
  getImage: () => null,
};

async function startApp() {
  const transport = new TransportService(stubRoon as RoonClient, stubLogger);
  const browse = new BrowseService(stubRoon as RoonClient, stubLogger);
  const images = new ImageService(stubRoon as RoonClient, stubLogger, '/tmp/__roon_test_img_cache__');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-test-rp-'));
  const recentlyPlayed = new RecentlyPlayedService(transport, stubLogger, {
    filePath: path.join(tmpDir, 'recently-played.json'),
  });
  await recentlyPlayed.start();
  const app = createHttpApp(stubRoon as RoonClient, transport, browse, images, recentlyPlayed, stubLogger);
  return new Promise<{ url: string; close: () => Promise<void>; recentlyPlayed: RecentlyPlayedService }>(
    (resolve) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
          recentlyPlayed,
        });
      });
    }
  );
}

describe('HTTP app routing', () => {
  let app: { url: string; close: () => Promise<void>; recentlyPlayed: RecentlyPlayedService };

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns JSON 404 for unknown /api/* routes (does not fall through to SPA)', async () => {
    const res = await fetch(`${app.url}/api/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Not Found');
  });

  it('answers /api/health', async () => {
    const res = await fetch(`${app.url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /api/recently-played returns the service\'s entries', async () => {
    // Inject an entry directly via the transport event the service
    // listens to. This avoids depending on the test harness having
    // a real Roon Core attached.
    const transport = (app.recentlyPlayed as any).transportService;
    transport.emit('now-playing-updated', {
      zone_id: 'zone-x',
      now_playing: {
        zone_id: 'zone-x',
        title: 'Test Track',
        artist: 'Test Artist',
        album: 'Test Album',
        state: 'playing',
      },
    });
    // The service updates the in-memory list synchronously on the
    // event, so a single tick is enough before fetching.
    await new Promise((r) => setImmediate(r));

    const res = await fetch(`${app.url}/api/recently-played`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ title: string }> };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries[0].title).toBe('Test Track');
  });

  it('GET /api/recently-played returns 503 when the service is degraded', async () => {
    // Force the degraded flag (in production this happens when the
    // eager generation persist fails at startup). Routes must refuse
    // to serve from a service whose epoch isn't durable — serving
    // would let clients adopt state that can't survive a restart.
    const svc = app.recentlyPlayed as unknown as { degraded: boolean };
    const saved = svc.degraded;
    svc.degraded = true;
    try {
      const res = await fetch(`${app.url}/api/recently-played`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/degraded/i);

      const delRes = await fetch(`${app.url}/api/recently-played`, { method: 'DELETE' });
      expect(delRes.status).toBe(503);
    } finally {
      svc.degraded = saved;
    }
  });

  it('DELETE /api/recently-played wipes the list', async () => {
    // Seed one entry, confirm it lands, then DELETE and confirm empty.
    const transport = (app.recentlyPlayed as any).transportService;
    transport.emit('now-playing-updated', {
      zone_id: 'zone-y',
      now_playing: {
        zone_id: 'zone-y',
        title: 'Doomed Track',
        state: 'playing',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(app.recentlyPlayed.getEntries().length).toBeGreaterThan(0);

    const res = await fetch(`${app.url}/api/recently-played`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
    expect(app.recentlyPlayed.getEntries()).toEqual([]);
  });
});
