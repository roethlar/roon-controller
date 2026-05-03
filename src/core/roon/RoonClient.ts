/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { Logger } from "pino";

const RoonApi = require("node-roon-api");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiBrowse = require("node-roon-api-browse");
const RoonApiImage = require("node-roon-api-image");

export interface RoonClientOptions {
  tokenPath: string;
  logger: Logger;
}

export interface RoonCoreInfo {
  readonly id: string;
  readonly displayName: string;
  readonly displayVersion: string;
}

export interface RoonEvents {
  readonly coreStatus: "discovering" | "paired" | "unpaired";
  readonly coreInfo?: RoonCoreInfo;
}

export declare interface RoonClient {
  on(event: "core-status", listener: (event: RoonEvents) => void): this;
  emit(event: "core-status", data: RoonEvents): boolean;
}

export class RoonClient extends EventEmitter {
  private readonly options: RoonClientOptions;
  private roon!: any;
  private transport: any | null = null;
  private browse: any | null = null;
  private image: any | null = null;
  private pairedCore: RoonCoreInfo | null = null;
  private coreStatus: "discovering" | "paired" | "unpaired" = "discovering";

  constructor(options: RoonClientOptions) {
    super();
    this.options = options;
  }

  public start(): void {
    const token = this.loadToken();

    this.roon = new RoonApi({
      extension_id: "com.roonlabs.webcontroller",
      display_name: "Custom Roon Controller",
      display_version: "1.0.0",
      publisher: "Michael Coelho",
      email: "mcoelho@gmail.com",
      website: "https://github.com/mcoelho/roon-controller",
      token,
      log_level: this.options.logger.level ?? "info",
      save_config: (_roon: any, newToken: unknown) => {
        this.persistToken(newToken);
      },
      core_paired: (core: any) => {
        this.onCorePaired(core);
      },
      core_unpaired: () => {
        this.onCoreUnpaired();
      },
    });

    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      optional_services: [RoonApiImage],
      provided_services: [],
    });

    this.emit("core-status", { coreStatus: "discovering" });
    this.roon.start_discovery();
  }

  public getTransport(): any | null {
    return this.transport;
  }

  public getBrowse(): any | null {
    return this.browse;
  }

  public getImage(): any | null {
    return this.image;
  }

  public getCoreInfo(): RoonCoreInfo | null {
    return this.pairedCore;
  }

  public getCoreStatus(): "discovering" | "paired" | "unpaired" {
    return this.coreStatus;
  }

  private onCorePaired(core: any): void {
    this.options.logger.info(
      {
        coreName: core.display_name,
        version: core.display_version,
      },
      "Paired with Roon core"
    );

    this.coreStatus = "paired";
    this.pairedCore = {
      id: core.core_id,
      displayName: core.display_name,
      displayVersion: core.display_version,
    };

    this.transport = core.services?.RoonApiTransport ?? null;
    this.browse = core.services?.RoonApiBrowse ?? null;
    this.image = core.services?.RoonApiImage ?? null;

    this.emit("core-status", {
      coreStatus: "paired",
      coreInfo: this.pairedCore,
    });
  }

  private onCoreUnpaired(): void {
    this.options.logger.warn("Roon core unpaired");
    this.coreStatus = "unpaired";
    this.transport = null;
    this.browse = null;
    this.image = null;
    this.pairedCore = null;
    this.emit("core-status", { coreStatus: "unpaired" });
  }

  private loadToken(): unknown {
    try {
      const filePath = path.resolve(this.options.tokenPath);
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(buffer);
      }
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Failed to read saved Roon token"
      );
    }
    return null;
  }

  private persistToken(token: unknown): void {
    try {
      const filePath = path.resolve(this.options.tokenPath);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // Restrictive mode: token grants Roon control identity, treat as a secret.
      fs.writeFileSync(filePath, JSON.stringify(token, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      this.options.logger.info({ filePath }, "Saved Roon pairing token");
    } catch (error) {
      this.options.logger.error({ err: error }, "Failed to save Roon token");
    }
  }
}
