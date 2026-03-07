/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "events";
import { Logger } from "pino";

import {
  BrowseItem,
  BrowseLoadOptions,
  BrowseOptions,
  BrowsePopOptions,
  BrowseResult,
  BrowseSearchOptions,
  SearchResult,
} from "../../shared/types";
import { RoonClient } from "./RoonClient";
import { CoreUnpairedError } from "./errors";

export declare interface BrowseService {
  on(event: "browse-result", listener: (result: BrowseResult) => void): this;
  emit(event: "browse-result", result: BrowseResult): boolean;

  on(event: "search-result", listener: (result: SearchResult[]) => void): this;
  emit(event: "search-result", result: SearchResult[]): boolean;
}

/**
 * Wrapper around RoonApiBrowse providing normalized outputs.
 *
 * The Roon Browse API exposes two methods:
 *   browse(opts, cb) — navigate the hierarchy (drill in, pop, reset)
 *   load(opts, cb)   — fetch items at the current browse level
 *
 * browse() returns list metadata (title, count, level) but NOT items.
 * A separate load() call is always required to retrieve actual items.
 * "Pop" is done via browse() with the pop_levels parameter.
 */
export class BrowseService extends EventEmitter {
  constructor(
    private readonly roonClient: RoonClient,
    private readonly logger: Logger
  ) {
    super();
  }

  /**
   * Navigate the browse hierarchy and return items.
   * Internally calls Roon browse() then load() to fetch items.
   */
  public async browse(options: BrowseOptions): Promise<BrowseResult> {
    this.logger.info({ options }, "BrowseService browse invoked");
    const browseResponse = await this.invokeBrowse(this.mapBrowseOptions(options));

    const items = await this.loadItemsForList(browseResponse, options.hierarchy, options.offset);
    const normalized = this.buildResult(browseResponse, items);

    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
        itemCount: normalized.items.length,
      },
      "BrowseService browse result"
    );
    this.emit("browse-result", normalized);
    return normalized;
  }

  /**
   * Load items at the current browse level (pagination).
   * Roon load() accepts: hierarchy, offset, count, level.
   */
  public async load(options: BrowseLoadOptions): Promise<BrowseResult> {
    this.logger.info({ options }, "BrowseService load invoked");
    const loadResponse = await this.invokeLoad(this.mapLoadOptions(options));

    const normalized = this.normalizeLoadResponse(loadResponse);
    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
        itemCount: normalized.items.length,
      },
      "BrowseService load result"
    );
    this.emit("browse-result", normalized);
    return normalized;
  }

  /**
   * Pop the browse stack by the requested number of levels.
   * Implemented via Roon browse() with pop_levels parameter,
   * then load() to fetch items at the resulting level.
   */
  public async pop(options: BrowsePopOptions): Promise<BrowseResult> {
    this.logger.info({ options }, "BrowseService pop invoked");
    const browseResponse = await this.invokeBrowse(this.mapPopOptions(options));

    const items = await this.loadItemsForList(browseResponse, options.hierarchy, 0);
    const normalized = this.buildResult(browseResponse, items);

    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
        itemCount: normalized.items.length,
      },
      "BrowseService pop result"
    );
    this.emit("browse-result", normalized);
    return normalized;
  }

  /**
   * Perform a search using the browse hierarchy
   */
  public async search(options: BrowseSearchOptions): Promise<SearchResult[]> {
    this.logger.info({ options }, "BrowseService search invoked");
    const browseOptions: BrowseOptions = {
      hierarchy: "search",
      zoneId: options.zoneId,
      input: options.input,
      offset: options.offset,
      popAll: true,
    };

    const result = await this.browse(browseOptions);
    const searchResults = result.items.map((item) => this.toSearchResult(item));
    this.logger.debug(
      { query: options.input, count: searchResults.length },
      "BrowseService search result"
    );
    this.emit("search-result", searchResults);
    return searchResults;
  }

  // ── Roon API Invocation ──────────────────────────────────────────────

  private getBrowseService(): any {
    const browse = this.roonClient.getBrowse();
    if (!browse) {
      this.logger.warn("Browse requested while core unpaired");
      throw new CoreUnpairedError("Browse service unavailable");
    }
    return browse;
  }

  /**
   * Call Roon's browse() endpoint.
   */
  private invokeBrowse(params: Record<string, unknown>): Promise<any> {
    return this.invoke("browse", params);
  }

  /**
   * Call Roon's load() endpoint.
   */
  private invokeLoad(params: Record<string, unknown>): Promise<any> {
    return this.invoke("load", params);
  }

  private async invoke(
    method: "browse" | "load",
    params: Record<string, unknown>
  ): Promise<any> {
    const service = this.getBrowseService();
    this.logger.debug({ method, params }, "Invoking Roon browse API");

    return new Promise((resolve, reject) => {
      try {
        service[method](params, (error: unknown, response: any) => {
          if (error) {
            this.logger.error({ err: error, method }, "Roon browse call failed");
            reject(
              error instanceof Error
                ? error
                : new Error(`[BrowseService] ${method} failed`)
            );
            return;
          }

          resolve(response);
        });
      } catch (error) {
        this.logger.error({ err: error, method }, "Roon browse invocation crashed");
        reject(
          error instanceof Error
            ? error
            : new Error(`[BrowseService] ${method} invocation failed`)
        );
      }
    });
  }

  // ── Parameter Mapping ────────────────────────────────────────────────

  private mapBrowseOptions(options: BrowseOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
    };

    if (options.zoneId) {
      params.zone_or_output_id = options.zoneId;
    }

    if (options.itemKey) {
      params.item_key = options.itemKey;
    }

    if (options.input) {
      params.input = options.input;
    }

    if (typeof options.setDisplayOffset === "number") {
      params.set_display_offset = options.setDisplayOffset;
    }

    if (typeof options.refresh === "boolean") {
      params.refresh_list = options.refresh;
    }

    if (options.multiSessionKey) {
      params.multi_session_key = options.multiSessionKey;
    }

    if (options.popAll) {
      params.pop_all = true;
    }

    return params;
  }

  /**
   * Map load options. Roon load() accepts:
   *   hierarchy, offset, count, level, set_display_offset
   * It does NOT accept item_key (that's a browse parameter).
   */
  private mapLoadOptions(options: BrowseLoadOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
    };

    if (options.zoneId) {
      params.zone_or_output_id = options.zoneId;
    }

    params.offset =
      typeof options.offset === "number" && Number.isFinite(options.offset)
        ? options.offset
        : 0;

    return params;
  }

  /**
   * Map pop options. Pop is done via browse() with pop_levels.
   */
  private mapPopOptions(options: BrowsePopOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
    };

    if (options.zoneId) {
      params.zone_or_output_id = options.zoneId;
    }

    if (typeof options.levels === "number") {
      params.pop_levels = options.levels;
    } else {
      // Default: pop one level
      params.pop_levels = 1;
    }

    return params;
  }

  // ── Item Loading & Normalization ─────────────────────────────────────

  /**
   * After a browse() call, fetch items via load() if the response
   * indicates a list with items to display.
   */
  private async loadItemsForList(
    browseResponse: any,
    hierarchy: string,
    offset?: number
  ): Promise<any[]> {
    if (browseResponse?.action !== "list") {
      return [];
    }

    const count = browseResponse?.list?.count ?? 0;
    if (count === 0) {
      return [];
    }

    const totalCount = browseResponse?.list?.count ?? 0;
    const startOffset =
      typeof offset === "number" && Number.isFinite(offset) ? offset : 0;

    this.logger.debug(
      { hierarchy, totalCount, startOffset },
      "Loading items for browse result"
    );

    const batchSize = 100;
    const allItems: any[] = [];

    for (let off = startOffset; off < totalCount; off += batchSize) {
      const loadResponse = await this.invokeLoad({
        hierarchy,
        offset: off,
        count: Math.min(batchSize, totalCount - off),
      });
      const batch = loadResponse?.items ?? [];
      allItems.push(...batch);
      if (batch.length < Math.min(batchSize, totalCount - off)) break;
    }

    return allItems;
  }

  /**
   * Build a BrowseResult from a browse() response + loaded items.
   */
  private buildResult(browseResponse: any, rawItems: any[]): BrowseResult {
    const list = browseResponse?.list ?? {};
    const normalizedItems = rawItems.map((item: any) => this.toBrowseItem(item));

    return {
      title: list.title ?? browseResponse?.title,
      subtitle: list.subtitle ?? undefined,
      level: this.ensureNumber(list.level, 0),
      offset: this.ensureNumber(list.display_offset ?? 0, 0),
      count: this.ensureNumber(list.count ?? normalizedItems.length, normalizedItems.length),
      totalCount: this.ensureOptionalNumber(list.count),
      items: normalizedItems,
    };
  }

  /**
   * Normalize a Roon load() response into a BrowseResult.
   * load() returns: { items: Item[], offset: number, list: List }
   */
  private normalizeLoadResponse(payload: any): BrowseResult {
    const list = payload?.list ?? {};
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const normalizedItems = rawItems.map((item: any) => this.toBrowseItem(item));

    return {
      title: list.title,
      level: this.ensureNumber(list.level, 0),
      offset: this.ensureNumber(payload?.offset ?? 0, 0),
      count: this.ensureNumber(list.count ?? normalizedItems.length, normalizedItems.length),
      totalCount: this.ensureOptionalNumber(list.count),
      items: normalizedItems,
    };
  }

  private toBrowseItem(item: any): BrowseItem {
    return {
      title: item?.title ?? "",
      subtitle: item?.subtitle ?? undefined,
      itemKey: item?.item_key ?? undefined,
      hint: item?.hint ?? item?.type ?? undefined,
      imageKey: item?.image_key ?? undefined,
      isLoadable: Boolean(item?.hint === "list" || item?.hint === "action_list"),
      isPlayable: Boolean(item?.hint === "action"),
      itemType: item?.item_type ?? item?.item_subtype ?? undefined,
    };
  }

  private toSearchResult(item: BrowseItem): SearchResult {
    return {
      ...item,
      resultType: this.inferSearchType(item),
    };
  }

  private inferSearchType(item: BrowseItem): SearchResult["resultType"] {
    const hint = (item.hint ?? "").toLowerCase();
    const type = (item.itemType ?? "").toLowerCase();

    const token = hint || type;

    switch (token) {
      case "artist":
      case "artists":
        return "artist";
      case "album":
      case "albums":
        return "album";
      case "track":
      case "tracks":
        return "track";
      case "playlist":
      case "playlists":
        return "playlist";
      case "genre":
      case "genres":
        return "genre";
      case "composer":
      case "composers":
        return "composer";
      case "label":
      case "labels":
        return "label";
      case "radio":
      case "stations":
        return "radio";
      default:
        return "unknown";
    }
  }

  private ensureNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : fallback;
  }

  private ensureOptionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }
}
