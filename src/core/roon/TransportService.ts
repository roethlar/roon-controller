/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "events";
import { Logger } from "pino";
import { RoonClient } from "./RoonClient";
import {
  Zone,
  NowPlaying,
  PlaybackState,
  VolumeSettings,
} from "../../shared/types";
import { CoreUnpairedError, RoonOperationError } from "./errors";

/**
 * Transport service event payloads
 */
export interface ZoneUpdatedEvent {
  zone: Zone;
}

export interface NowPlayingUpdatedEvent {
  zone_id: string;
  now_playing: NowPlaying;
}

export interface ZoneRemovedEvent {
  zone_id: string;
}

/**
 * TransportService event declarations for TypeScript
 */
export declare interface TransportService {
  on(event: "zone-updated", listener: (data: ZoneUpdatedEvent) => void): this;
  on(
    event: "now-playing-updated",
    listener: (data: NowPlayingUpdatedEvent) => void
  ): this;
  on(event: "zone-removed", listener: (data: ZoneRemovedEvent) => void): this;
  emit(event: "zone-updated", data: ZoneUpdatedEvent): boolean;
  emit(event: "now-playing-updated", data: NowPlayingUpdatedEvent): boolean;
  emit(event: "zone-removed", data: ZoneRemovedEvent): boolean;
}

/**
 * Transport Service Wrapper
 *
 * Provides high-level control over Roon playback and zone management.
 * Wraps the RoonApiTransport service with typed interfaces and event emission.
 *
 * Events:
 * - zone-updated: Emitted when zone state changes
 * - now-playing-updated: Emitted when track/playback changes
 */
export class TransportService extends EventEmitter {
  private transport: any | null = null;
  private subscriptions: Map<string, Zone> = new Map();

  constructor(
    private roonClient: RoonClient,
    private logger: Logger
  ) {
    super();
  }

  /**
   * Initialize transport service and subscribe to zone updates
   */
  public start(): void {
    this.transport = this.roonClient.getTransport();

    if (!this.transport) {
      this.logger.warn("Transport service not available yet, will retry on core pairing");
      return;
    }

    this.logger.info("TransportService started");
  }

  /**
   * Play or pause playback in a zone
   */
  public async playPause(zone_id: string): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      this.transport.control(zone_id, "playpause", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "playPause failed");
          reject(new RoonOperationError("playPause", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "playPause succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Skip to next track
   */
  public async next(zone_id: string): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      this.transport.control(zone_id, "next", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "next failed");
          reject(new RoonOperationError("next", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "next succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Skip to previous track
   */
  public async previous(zone_id: string): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      this.transport.control(zone_id, "previous", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "previous failed");
          reject(new RoonOperationError("previous", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "previous succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Stop playback
   */
  public async stop(zone_id: string): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      this.transport.control(zone_id, "stop", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "stop failed");
          reject(new RoonOperationError("stop", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "stop succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Change volume for an output
   * @param output_id - The output identifier
   * @param value - Volume value in Roon's native scale (from VolumeSettings.min to max)
   */
  public async setVolume(output_id: string, value: number): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      this.transport.change_volume(output_id, "absolute", value, (error: any) => {
        if (error) {
          this.logger.error({ err: error, output_id, value }, "setVolume failed");
          reject(new RoonOperationError("setVolume", error, { output_id, value }));
        } else {
          this.logger.debug({ output_id, value }, "setVolume succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Seek to position in current track
   * @param zone_id - Zone identifier
   * @param seconds - Position in seconds
   */
  public async seek(zone_id: string, seconds: number): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      this.transport.seek(zone_id, "absolute", seconds, (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id, seconds }, "seek failed");
          reject(new RoonOperationError("seek", error, { zone_id, seconds }));
        } else {
          this.logger.debug({ zone_id, seconds }, "seek succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Subscribe to zone updates
   * Emits zone-updated and now-playing-updated events
   */
  public subscribeZones(): void {
    this.ensureTransport();

    this.transport.subscribe_zones((response: any, data: any) => {
      if (response === "Subscribed") {
        this.logger.info("Subscribed to zone updates");
        this.handleZonesUpdate(data);
      } else if (response === "Changed") {
        this.handleZonesUpdate(data);
        this.handleSeekChanged(data);
      } else if (response === "Unsubscribed") {
        this.logger.warn("Unsubscribed from zone updates");
        this.subscriptions.clear();
      }
    });
  }

  /**
   * Get all zones from subscriptions
   */
  public getZones(): Zone[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Get specific zone by ID
   */
  public getZone(zone_id: string): Zone | undefined {
    return this.subscriptions.get(zone_id);
  }

  /**
   * Handle zone updates from Roon
   * Processes zones, zones_changed, zones_added, zones_removed
   */
  private handleZonesUpdate(data: any): void {
    if (!data) {
      return;
    }

    // Handle initial snapshot or full zones update
    if (data.zones) {
      for (const roonZone of data.zones) {
        const zone = this.normalizeZone(roonZone);
        this.subscriptions.set(zone.zone_id, zone);
        
        this.emit("zone-updated", { zone });

        if (roonZone.now_playing) {
          const nowPlaying = this.normalizeNowPlaying(roonZone);
          this.emit("now-playing-updated", {
            zone_id: zone.zone_id,
            now_playing: nowPlaying,
          });
        }
      }
    }

    // Handle incremental zone changes
    if (data.zones_changed) {
      for (const roonZone of data.zones_changed) {
        const zone = this.normalizeZone(roonZone);
        this.subscriptions.set(zone.zone_id, zone);
        
        this.emit("zone-updated", { zone });

        if (roonZone.now_playing) {
          const nowPlaying = this.normalizeNowPlaying(roonZone);
          this.emit("now-playing-updated", {
            zone_id: zone.zone_id,
            now_playing: nowPlaying,
          });
        }
      }
    }

    // Handle newly added zones
    if (data.zones_added) {
      for (const roonZone of data.zones_added) {
        const zone = this.normalizeZone(roonZone);
        this.subscriptions.set(zone.zone_id, zone);
        
        this.logger.info({ zone_id: zone.zone_id }, "Zone added");
        this.emit("zone-updated", { zone });

        if (roonZone.now_playing) {
          const nowPlaying = this.normalizeNowPlaying(roonZone);
          this.emit("now-playing-updated", {
            zone_id: zone.zone_id,
            now_playing: nowPlaying,
          });
        }
      }
    }

    // Handle removed zones
    if (data.zones_removed) {
      for (const zone_id of data.zones_removed) {
        this.subscriptions.delete(zone_id);
        this.logger.info({ zone_id }, "Zone removed");
        this.emit("zone-removed", { zone_id });
      }
    }
  }

  /**
   * Handle seek position updates without full zone updates
   */
  private handleSeekChanged(data: any): void {
    if (!data?.zones_seek_changed) {
      return;
    }

    for (const seekUpdate of data.zones_seek_changed) {
      const zoneId = seekUpdate.zone_id;
      const seekPosition = seekUpdate.seek_position;
      const queue_time_remaining = seekUpdate.queue_time_remaining;

      // Update stored zone if exists
      const zone = this.subscriptions.get(zoneId);
      if (zone) {
        zone.seek_position = seekPosition;
        this.subscriptions.set(zoneId, zone);
      }

      // Emit seek update (lightweight, for progress bars)
      this.logger.debug({ zone_id: zoneId, seek_position: seekPosition }, "Seek position updated");
    }
  }

  /**
   * Normalize Roon zone data to our Zone interface
   */
  private normalizeZone(roonZone: any): Zone {
    return {
      zone_id: roonZone.zone_id,
      display_name: roonZone.display_name,
      state: this.normalizeState(roonZone.state),
      seek_position: roonZone.now_playing?.seek_position,
      is_play_allowed: roonZone.is_play_allowed ?? false,
      is_pause_allowed: roonZone.is_pause_allowed ?? false,
      is_previous_allowed: roonZone.is_previous_allowed ?? false,
      is_next_allowed: roonZone.is_next_allowed ?? false,
      is_seek_allowed: roonZone.is_seek_allowed ?? false,
      outputs: roonZone.outputs?.map((output: any) => ({
        output_id: output.output_id,
        display_name: output.display_name,
        volume: output.volume ? this.normalizeVolume(output.volume) : undefined,
      })),
    };
  }

  /**
   * Normalize Roon now playing data to our NowPlaying interface
   */
  private normalizeNowPlaying(roonZone: any): NowPlaying {
    const np = roonZone.now_playing || {};

    return {
      zone_id: roonZone.zone_id,
      title: np.three_line?.line1,
      artist: np.three_line?.line2,
      album: np.three_line?.line3,
      duration: np.length,
      seek_position: np.seek_position,
      image_key: np.image_key,
      state: this.normalizeState(roonZone.state),
      loop: np.settings?.loop,
      shuffle: np.settings?.shuffle,
    };
  }

  /**
   * Normalize playback state string
   */
  private normalizeState(state: string): PlaybackState {
    const normalized = state?.toLowerCase();
    if (
      normalized === "playing" ||
      normalized === "paused" ||
      normalized === "stopped" ||
      normalized === "loading"
    ) {
      return normalized as PlaybackState;
    }
    return "stopped";
  }

  /**
   * Normalize volume settings
   */
  private normalizeVolume(roonVolume: any): VolumeSettings {
    return {
      type: roonVolume.type === "number" ? "number" : "incremental",
      min: roonVolume.min ?? 0,
      max: roonVolume.max ?? 100,
      value: roonVolume.value ?? 50,
      step: roonVolume.step,
      is_muted: roonVolume.is_muted ?? false,
    };
  }

  /**
   * Ensure transport service is available
   * @throws Error if core not paired or transport unavailable
   */
  private ensureTransport(): void {
    this.transport = this.roonClient.getTransport();

    if (!this.transport) {
      this.logger.error("Transport operation attempted without paired core");
      throw new CoreUnpairedError("Transport service unavailable");
    }
  }
}
