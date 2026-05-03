import http from 'http';
import { AddressInfo } from 'net';
import { createHttpApp } from '../app';
import { RoonClient } from '../../../core/roon/RoonClient';
import { TransportService } from '../../../core/roon/TransportService';
import { BrowseService } from '../../../core/roon/BrowseService';
import { ImageService } from '../../../core/roon/ImageService';

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

function startApp() {
  const transport = new TransportService(stubRoon as RoonClient, stubLogger);
  const browse = new BrowseService(stubRoon as RoonClient, stubLogger);
  const images = new ImageService(stubRoon as RoonClient, stubLogger, '/tmp/__roon_test_img_cache__');
  const app = createHttpApp(stubRoon as RoonClient, transport, browse, images, stubLogger);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('HTTP app routing', () => {
  let app: { url: string; close: () => Promise<void> };

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
});
