/* eslint-disable @typescript-eslint/no-explicit-any */
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
 *
 * This service is request/response — it does not emit events. Socket
 * handlers return per-socket results to avoid leaking one client's browse
 * navigation into another's.
 */
export class BrowseService {
  constructor(
    private readonly roonClient: RoonClient,
    private readonly logger: Logger
  ) {}

  /**
   * Navigate the browse hierarchy and return items.
   * Internally calls Roon browse() then load() to fetch items.
   */
  public async browse(options: BrowseOptions): Promise<BrowseResult> {
    this.logger.debug({ options }, "BrowseService browse invoked");
    const browseResponse = await this.invokeBrowse(this.mapBrowseOptions(options));

    const items = await this.loadItemsForList(browseResponse, options);
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
    return normalized;
  }

  /**
   * Load items at the current browse level (pagination).
   * Roon load() accepts: hierarchy, offset, count, level.
   */
  public async load(options: BrowseLoadOptions): Promise<BrowseResult> {
    this.logger.debug({ options }, "BrowseService load invoked");
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
    return normalized;
  }

  /**
   * Pop the browse stack by the requested number of levels.
   * Implemented via Roon browse() with pop_levels parameter,
   * then load() to fetch items at the resulting level.
   */
  public async pop(options: BrowsePopOptions): Promise<BrowseResult> {
    this.logger.debug({ options }, "BrowseService pop invoked");
    const browseResponse = await this.invokeBrowse(this.mapPopOptions(options));

    const items = await this.loadItemsForList(browseResponse, {
      hierarchy: options.hierarchy,
      zoneId: options.zoneId,
      multiSessionKey: options.multiSessionKey,
      offset: 0,
      pageSize: options.pageSize,
    });
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
    return normalized;
  }

  /**
   * Perform a search using the browse hierarchy
   */
  public async search(options: BrowseSearchOptions): Promise<SearchResult[]> {
    this.logger.debug({ options }, "BrowseService search invoked");
    const browseOptions: BrowseOptions = {
      hierarchy: "search",
      zoneId: options.zoneId,
      input: options.input,
      offset: options.offset,
      multiSessionKey: options.multiSessionKey,
      popAll: options.popAll ?? true,
    };

    const result = await this.browse(browseOptions);
    const searchResults = result.items.map((item) => this.toSearchResult(item));
    this.logger.debug(
      { query: options.input, count: searchResults.length },
      "BrowseService search result"
    );
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

  /**
   * Clamp a numeric input that we forward to Roon. Negative values
   * and non-finite values are coerced to `defaultValue`; values
   * above `max` are clamped to `max`. Pass `min: 0` for offsets,
   * `min: 1` for counts/levels.
   */
  private static clamp(
    value: unknown,
    { min, max, defaultValue }: { min: number; max: number; defaultValue: number }
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
    if (value < min) return min;
    if (value > max) return max;
    return Math.floor(value);
  }

  private static readonly MAX_OFFSET = 1_000_000;
  private static readonly MAX_COUNT = 5_000;
  private static readonly MAX_POP_LEVELS = 32;

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
      params.set_display_offset = BrowseService.clamp(options.setDisplayOffset, {
        min: 0,
        max: BrowseService.MAX_OFFSET,
        defaultValue: 0,
      });
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

    params.offset = BrowseService.clamp(options.offset, {
      min: 0,
      max: BrowseService.MAX_OFFSET,
      defaultValue: 0,
    });

    if (typeof options.count === "number" && Number.isFinite(options.count)) {
      params.count = BrowseService.clamp(options.count, {
        min: 1,
        max: BrowseService.MAX_COUNT,
        defaultValue: BrowseService.PAGE_SIZE,
      });
    }

    if (options.multiSessionKey) {
      params.multi_session_key = options.multiSessionKey;
    }

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

    params.pop_levels = BrowseService.clamp(options.levels, {
      min: 1,
      max: BrowseService.MAX_POP_LEVELS,
      defaultValue: 1,
    });

    if (options.multiSessionKey) {
      params.multi_session_key = options.multiSessionKey;
    }

    return params;
  }

  // ── Item Loading & Normalization ─────────────────────────────────────

  private static readonly PAGE_SIZE = 100;

  /**
   * After a browse() call, fetch items via load(). By default loads one
   * page (PAGE_SIZE items) starting from `options.offset`. Pass
   * `pageSize: Infinity` to load the entire list (e.g. for small action
   * lists or quickPlay lookups). Larger lists should be paged via
   * `BrowseService.load()` from the client.
   */
  private async loadItemsForList(
    browseResponse: any,
    options: Pick<BrowseOptions, "hierarchy" | "zoneId" | "offset" | "multiSessionKey" | "pageSize">
  ): Promise<any[]> {
    if (browseResponse?.action !== "list") {
      return [];
    }

    const count = browseResponse?.list?.count ?? 0;
    if (count === 0) {
      return [];
    }

    const totalCount = count;
    const startOffset =
      typeof options.offset === "number" && Number.isFinite(options.offset) ? options.offset : 0;

    const requestedPage =
      options.pageSize === Infinity
        ? totalCount
        : typeof options.pageSize === "number" && options.pageSize > 0
          ? Math.floor(options.pageSize)
          : BrowseService.PAGE_SIZE;
    const targetEnd = Math.min(totalCount, startOffset + requestedPage);

    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        totalCount,
        startOffset,
        targetEnd,
        multiSessionKey: options.multiSessionKey,
      },
      "Loading items for browse result"
    );

    const batchSize = BrowseService.PAGE_SIZE;
    const allItems: any[] = [];

    for (let off = startOffset; off < targetEnd; off += batchSize) {
      const requestCount = Math.min(batchSize, targetEnd - off);
      const loadResponse = await this.invokeLoad(this.mapLoadOptions({
        hierarchy: options.hierarchy,
        zoneId: options.zoneId,
        offset: off,
        count: requestCount,
        multiSessionKey: options.multiSessionKey,
      }));
      const batch = loadResponse?.items ?? [];
      allItems.push(...batch);
      if (batch.length < requestCount) break;
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
    // Prefer itemType (semantic — e.g. "album", "artist") over hint
    // (structural — e.g. "list", "action_list"). Roon search results almost
    // always carry both; falling back to hint only matters for unusual items.
    const type = (item.itemType ?? "").toLowerCase();
    const hint = (item.hint ?? "").toLowerCase();
    const token = type || hint;

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
