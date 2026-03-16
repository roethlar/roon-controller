/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "events";
import { Logger } from "pino";
import { RoonClient } from "./RoonClient";
import {
  Zone,
  NowPlaying,
  PlaybackState,
  VolumeSettings,
  QueueItem,
  ZoneQueue,
  ZonePlaybackSettingsRequest,
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

export interface QueueUpdatedEvent {
  queue: ZoneQueue;
}

export interface SeekChangedEvent {
  zone_id: string;
  seek_position: number;
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
  on(event: "queue-updated", listener: (data: QueueUpdatedEvent) => void): this;
  on(event: "seek-changed", listener: (data: SeekChangedEvent) => void): this;
  emit(event: "zone-updated", data: ZoneUpdatedEvent): boolean;
  emit(event: "now-playing-updated", data: NowPlayingUpdatedEvent): boolean;
  emit(event: "zone-removed", data: ZoneRemovedEvent): boolean;
  emit(event: "queue-updated", data: QueueUpdatedEvent): boolean;
  emit(event: "seek-changed", data: SeekChangedEvent): boolean;
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
  private static readonly MIN_QUEUE_SUBSCRIPTION_ITEMS = 5000;
  private static readonly QUEUE_SUBSCRIPTION_HEADROOM = 32;

  private transport: any | null = null;
  private subscriptions: Map<string, Zone> = new Map();
  private nowPlayingByZone: Map<string, NowPlaying> = new Map();
  private queueByZone: Map<string, ZoneQueue> = new Map();
  private queueSubscriptions: Map<
    string,
    {
      max_item_count: number;
      unsubscribe?: (cb?: (error?: unknown) => void) => void;
    }
  > = new Map();

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
   * Update zone playback settings (shuffle / loop / auto radio).
   */
  public async setPlaybackSettings(
    zone_id: string,
    settings: Omit<ZonePlaybackSettingsRequest, "zone_id">
  ): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      const request: Record<string, unknown> = {};

      if (typeof settings.shuffle === "boolean") {
        request.shuffle = settings.shuffle;
      }
      if (typeof settings.auto_radio === "boolean") {
        request.auto_radio = settings.auto_radio;
      }
      if (settings.loop) {
        request.loop = settings.loop;
      }

      this.transport.change_settings(zone_id, request, (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id, settings }, "setPlaybackSettings failed");
          reject(new RoonOperationError("setPlaybackSettings", error, { zone_id, settings }));
        } else {
          this.logger.debug({ zone_id, settings }, "setPlaybackSettings succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Subscribe to queue updates for a zone.
   * Safe to call repeatedly (idempotent per zone_id).
   */
  public subscribeQueue(zone_id: string, max_item_count?: number): void {
    this.ensureTransport();

    const targetCount = this.resolveQueueSubscriptionSize(zone_id, max_item_count);
    const existingSubscription = this.queueSubscriptions.get(zone_id);

    if (existingSubscription && existingSubscription.max_item_count >= targetCount) {
      return;
    }

    if (existingSubscription) {
      try {
        existingSubscription.unsubscribe?.();
      } catch (error) {
        this.logger.warn(
          { err: error, zone_id },
          "Queue unsubscribe failed before re-subscribing"
        );
      }
      this.queueSubscriptions.delete(zone_id);
    }

    const subscription = this.transport.subscribe_queue(
      zone_id,
      targetCount,
      (response: any, data: any) => {
        this.handleQueueUpdate(zone_id, targetCount, response, data);
      }
    );

    this.queueSubscriptions.set(zone_id, {
      max_item_count: targetCount,
      unsubscribe: subscription?.unsubscribe,
    });
  }

  /**
   * Get queue snapshot for a zone.
   */
  public getQueue(zone_id: string): ZoneQueue {
    const existing = this.queueByZone.get(zone_id);
    if (existing) {
      return existing;
    }

    const empty: ZoneQueue = {
      zone_id,
      items: [],
      max_item_count:
        this.queueSubscriptions.get(zone_id)?.max_item_count ??
        this.resolveQueueSubscriptionSize(zone_id),
      updated_at: new Date().toISOString(),
    };
    this.queueByZone.set(zone_id, empty);
    return empty;
  }

  /**
   * Start playback from a specific queue item.
   */
  public async playFromHere(zone_id: string, queue_item_id: number): Promise<void> {
    this.ensureTransport();

    return new Promise((resolve, reject) => {
      this.transport.play_from_here(zone_id, queue_item_id, (error: any) => {
        if (error && error.name && error.name !== "Success") {
          this.logger.error({ err: error, zone_id, queue_item_id }, "playFromHere failed");
          reject(new RoonOperationError("playFromHere", error.name, { zone_id, queue_item_id }));
        } else {
          this.logger.debug({ zone_id, queue_item_id }, "playFromHere succeeded");
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
   * Get all cached now-playing states (used to hydrate new socket connections)
   */
  public getNowPlayingAll(): NowPlaying[] {
    return Array.from(this.nowPlayingByZone.values());
  }

  /**
   * Reset all in-memory transport state.
   * Useful when the core disconnects/unpairs and previously cached zones are stale.
   */
  public resetState(): void {
    this.subscriptions.clear();
    this.nowPlayingByZone.clear();
    this.queueByZone.clear();

    for (const [zone_id, subscription] of this.queueSubscriptions.entries()) {
      try {
        subscription.unsubscribe?.();
      } catch (error) {
        this.logger.warn({ err: error, zone_id }, "Failed to unsubscribe queue listener");
      }
    }
    this.queueSubscriptions.clear();
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
          this.emitNowPlaying(zone.zone_id, this.normalizeNowPlaying(roonZone));
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
          this.emitNowPlaying(zone.zone_id, this.normalizeNowPlaying(roonZone));
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
          this.emitNowPlaying(zone.zone_id, this.normalizeNowPlaying(roonZone));
        }
      }
    }

    // Handle removed zones
    if (data.zones_removed) {
      for (const zone_id of data.zones_removed) {
        this.subscriptions.delete(zone_id);
        this.nowPlayingByZone.delete(zone_id);
        this.queueByZone.delete(zone_id);
        const queueSubscription = this.queueSubscriptions.get(zone_id);
        if (queueSubscription) {
          try {
            queueSubscription.unsubscribe?.();
          } catch (error) {
            this.logger.warn({ err: error, zone_id }, "Queue unsubscribe failed on zone removal");
          }
          this.queueSubscriptions.delete(zone_id);
        }

        this.logger.info({ zone_id }, "Zone removed");
        this.emit("zone-removed", { zone_id });
        this.emit("queue-updated", {
          queue: {
            zone_id,
            items: [],
            max_item_count: this.resolveQueueSubscriptionSize(zone_id),
            updated_at: new Date().toISOString(),
          },
        });
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

      // Update stored zone if exists
      const zone = this.subscriptions.get(zoneId);
      if (zone) {
        zone.seek_position = seekPosition;
        this.subscriptions.set(zoneId, zone);
      }

      this.emit("seek-changed", { zone_id: zoneId, seek_position: seekPosition });
    }
  }

  /**
   * Handle queue subscription updates for a zone.
   */
  private handleQueueUpdate(
    zone_id: string,
    max_item_count: number,
    response: string,
    data: any
  ): void {
    if (response === "Unsubscribed") {
      this.queueByZone.delete(zone_id);
      this.queueSubscriptions.delete(zone_id);
      this.emit("queue-updated", {
        queue: {
          zone_id,
          items: [],
          max_item_count,
          updated_at: new Date().toISOString(),
        },
      });
      return;
    }

    const existing = this.getQueue(zone_id);
    let nextItems = [...existing.items];

    if (Array.isArray(data?.items)) {
      nextItems = data.items.map((item: any) => this.normalizeQueueItem(item));
    }

    if (Array.isArray(data?.items_changed)) {
      for (const raw of data.items_changed) {
        const item = this.normalizeQueueItem(raw);
        const index = nextItems.findIndex((current) => current.queue_item_id === item.queue_item_id);
        if (index >= 0) {
          nextItems[index] = item;
        } else {
          nextItems.push(item);
        }
      }
    }

    if (Array.isArray(data?.items_added)) {
      for (const raw of data.items_added) {
        const item = this.normalizeQueueItem(raw);
        const exists = nextItems.some((current) => current.queue_item_id === item.queue_item_id);
        if (!exists) {
          nextItems.push(item);
        }
      }
    }

    if (Array.isArray(data?.items_removed)) {
      const removedIds = new Set<number>();
      for (const raw of data.items_removed) {
        const id = this.extractQueueItemId(raw);
        if (typeof id === "number") {
          removedIds.add(id);
        }
      }
      if (removedIds.size > 0) {
        nextItems = nextItems.filter((item) => !removedIds.has(item.queue_item_id));
      }
    }

    nextItems.sort((a, b) => a.queue_item_id - b.queue_item_id);

    const snapshot: ZoneQueue = {
      zone_id,
      items: nextItems,
      max_item_count,
      updated_at: new Date().toISOString(),
    };

    this.queueByZone.set(zone_id, snapshot);
    this.emit("queue-updated", { queue: snapshot });
  }

  private normalizeQueueItem(item: any): QueueItem {
    return {
      queue_item_id: this.extractQueueItemId(item) ?? 0,
      length: typeof item?.length === "number" ? item.length : undefined,
      image_key: item?.image_key,
      one_line: item?.one_line,
      two_line: item?.two_line,
      three_line: item?.three_line,
    };
  }

  private extractQueueItemId(item: any): number | undefined {
    if (typeof item === "number" && Number.isFinite(item)) {
      return item;
    }
    if (typeof item?.queue_item_id === "number" && Number.isFinite(item.queue_item_id)) {
      return item.queue_item_id;
    }
    return undefined;
  }

  /**
   * Resolve queue subscription size so "full queue" snapshots are practical by default.
   * Uses zone queue metadata when available and enforces a large minimum.
   */
  private resolveQueueSubscriptionSize(
    zone_id: string,
    requestedMaxItemCount?: number
  ): number {
    const requested =
      typeof requestedMaxItemCount === "number" &&
      Number.isFinite(requestedMaxItemCount) &&
      requestedMaxItemCount > 0
        ? Math.floor(requestedMaxItemCount)
        : 0;

    const zone = this.subscriptions.get(zone_id);
    const basedOnZone =
      typeof zone?.queue_items_remaining === "number" && zone.queue_items_remaining >= 0
        ? zone.queue_items_remaining +
          1 +
          TransportService.QUEUE_SUBSCRIPTION_HEADROOM
        : 0;

    return Math.max(
      TransportService.MIN_QUEUE_SUBSCRIPTION_ITEMS,
      requested,
      basedOnZone
    );
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
      queue_items_remaining:
        typeof roonZone.queue_items_remaining === "number"
          ? roonZone.queue_items_remaining
          : undefined,
      queue_time_remaining:
        typeof roonZone.queue_time_remaining === "number"
          ? roonZone.queue_time_remaining
          : undefined,
      settings: roonZone.settings
        ? {
            loop: roonZone.settings.loop,
            shuffle: roonZone.settings.shuffle,
            auto_radio: roonZone.settings.auto_radio,
          }
        : undefined,
      outputs: roonZone.outputs?.map((output: any) => ({
        output_id: output.output_id,
        display_name: output.display_name,
        volume: output.volume ? this.normalizeVolume(output.volume) : undefined,
      })),
    };
  }

  private emitNowPlaying(zone_id: string, nowPlaying: NowPlaying): void {
    this.nowPlayingByZone.set(zone_id, nowPlaying);
    this.emit("now-playing-updated", { zone_id, now_playing: nowPlaying });
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
