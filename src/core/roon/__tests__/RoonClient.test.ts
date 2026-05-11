import { promises as fsp } from "fs";
import fs from "fs";
import path from "path";
import os from "os";
import { Logger } from "pino";

// Capture the options the lib was constructed with so tests can poke
// at get_persisted_state / set_persisted_state directly. RoonApi is a
// no-op stub here — start() must not try to discover/network during a
// unit test.
let capturedOptions: any = null;
jest.mock("node-roon-api", () => {
  return jest.fn().mockImplementation((opts: unknown) => {
    capturedOptions = opts;
    return {
      init_services: jest.fn(),
      start_discovery: jest.fn(),
    };
  });
});
jest.mock("node-roon-api-transport", () => ({}));
jest.mock("node-roon-api-browse", () => ({}));
jest.mock("node-roon-api-image", () => ({}));

import { RoonClient } from "../RoonClient";

const stubLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

async function makeTokenPath(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-token-"));
  return path.join(dir, "roon-token.json");
}

beforeEach(() => {
  capturedOptions = null;
  jest.clearAllMocks();
});

describe("RoonClient — persisted-state callbacks", () => {
  it("get_persisted_state returns {} when token file does not exist", async () => {
    const tokenPath = await makeTokenPath();
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(capturedOptions.get_persisted_state).toBeInstanceOf(Function);
    expect(capturedOptions.get_persisted_state()).toEqual({});
  });

  it("get_persisted_state reads and parses an existing JSON file", async () => {
    const tokenPath = await makeTokenPath();
    const persisted = {
      paired_core_id: "core-abc",
      tokens: { "core-abc": "tk-xyz" },
    };
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(tokenPath, JSON.stringify(persisted), "utf-8");

    new RoonClient({ tokenPath, logger: stubLogger }).start();
    expect(capturedOptions.get_persisted_state()).toEqual(persisted);
  });

  it("get_persisted_state returns {} when the file is corrupt (and warns)", async () => {
    const tokenPath = await makeTokenPath();
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(tokenPath, "{ not json", "utf-8");

    new RoonClient({ tokenPath, logger: stubLogger }).start();
    expect(capturedOptions.get_persisted_state()).toEqual({});
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it("set_persisted_state writes JSON atomically (tmp + rename, no leftover .tmp)", async () => {
    const tokenPath = await makeTokenPath();
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    const state = {
      paired_core_id: "core-1",
      tokens: { "core-1": "secret-token" },
    };
    capturedOptions.set_persisted_state(state);

    const onDisk = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    expect(onDisk).toEqual(state);
    expect(fs.existsSync(`${tokenPath}.tmp`)).toBe(false);
    // 0o600 — the token grants Roon control identity.
    const mode = fs.statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("set_persisted_state creates the parent directory if missing", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-token-"));
    // Configure a nested path that doesn't yet exist.
    const tokenPath = path.join(tmpDir, "nested", "subdir", "roon-token.json");

    new RoonClient({ tokenPath, logger: stubLogger }).start();
    capturedOptions.set_persisted_state({ tokens: { "c": "x" } });

    expect(fs.existsSync(tokenPath)).toBe(true);
  });
});

describe("RoonClient — legacy config.json migration", () => {
  let originalCwd: string;
  let cwdDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwdDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-cwd-"));
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("migrates a pre-existing config.json from cwd to the configured tokenPath", async () => {
    const legacyPath = path.join(cwdDir, "config.json");
    const persisted = {
      paired_core_id: "core-legacy",
      tokens: { "core-legacy": "legacy-token" },
    };
    await fsp.writeFile(legacyPath, JSON.stringify(persisted), "utf-8");

    const tokenPath = path.join(cwdDir, "data", "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    // Migrated to the configured path…
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(tokenPath, "utf-8"))).toEqual(persisted);
    // …and removed from cwd so it can't drift back into use.
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("does NOT migrate when the configured tokenPath already exists (no clobber)", async () => {
    const legacyPath = path.join(cwdDir, "config.json");
    await fsp.writeFile(legacyPath, JSON.stringify({ tokens: { x: "legacy" } }), "utf-8");

    const tokenPath = path.join(cwdDir, "roon-token.json");
    await fsp.writeFile(tokenPath, JSON.stringify({ tokens: { y: "current" } }), "utf-8");

    new RoonClient({ tokenPath, logger: stubLogger }).start();

    // Configured target untouched, legacy file untouched.
    expect(JSON.parse(fs.readFileSync(tokenPath, "utf-8"))).toEqual({
      tokens: { y: "current" },
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("skips migration when the legacy file is not valid JSON", async () => {
    const legacyPath = path.join(cwdDir, "config.json");
    await fsp.writeFile(legacyPath, "{ not json", "utf-8");

    const tokenPath = path.join(cwdDir, "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true); // left for human inspection
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it("does nothing when neither file exists", async () => {
    const tokenPath = path.join(cwdDir, "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(capturedOptions.get_persisted_state()).toEqual({});
  });
});
