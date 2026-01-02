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
 * Wrapper around RoonApiBrowse providing normalized outputs
 */
export class BrowseService extends EventEmitter {
  constructor(
    private readonly roonClient: RoonClient,
    private readonly logger: Logger
  ) {
    super();
  }

  /**
   * Entry-point for browsing the Roon hierarchy
   */
  public async browse(options: BrowseOptions): Promise<BrowseResult> {
    this.logger.info({ options }, "BrowseService browse invoked");
    const response = await this.invoke("browse", this.mapBrowseOptions(options));
    if (!Array.isArray(response?.list?.items)) {
      this.logger.warn(
        { hierarchy: options.hierarchy, raw: response?.list },
        "BrowseService browse response missing items"
      );
    }

    const normalized = this.normalizeResult(response);
    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
      },
      "BrowseService browse result"
    );
    this.emit("browse-result", normalized);
    return normalized;
  }

  /**
   * Load additional items for a previously retrieved hierarchy node
   */
  public async load(options: BrowseLoadOptions): Promise<BrowseResult> {
    this.logger.info({ options }, "BrowseService load invoked");
    const response = await this.invoke("load", this.mapLoadOptions(options));
    if (!Array.isArray(response?.list?.items)) {
      this.logger.warn(
        { hierarchy: options.hierarchy, itemKey: options.itemKey, raw: response?.list },
        "BrowseService load response missing items"
      );
    }

    const normalized = this.normalizeResult(response);
    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        itemKey: options.itemKey,
        level: normalized.level,
        count: normalized.count,
      },
      "BrowseService load result"
    );
    this.emit("browse-result", normalized);
    return normalized;
  }

  /**
   * Pop the browse stack by the requested number of levels
   */
  public async pop(options: BrowsePopOptions): Promise<BrowseResult> {
    this.logger.info({ options }, "BrowseService pop invoked");
    const response = await this.invoke("pop", this.mapPopOptions(options));
    if (!Array.isArray(response?.list?.items)) {
      this.logger.warn(
        { hierarchy: options.hierarchy, raw: response?.list },
        "BrowseService pop response missing items"
      );
    }

    const normalized = this.normalizeResult(response);
    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
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

  private getBrowseService(): any {
    const browse = this.roonClient.getBrowse();
    if (!browse) {
      this.logger.warn("Browse requested while core unpaired");
      throw new CoreUnpairedError("Browse service unavailable");
    }
    return browse;
  }

  private async invoke(
    method: "browse" | "load" | "pop",
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

    params.offset =
      typeof options.offset === "number" && Number.isFinite(options.offset)
        ? options.offset
        : 0;

    if (typeof options.setDisplayOffset === "number") {
      params.set_display_offset = options.setDisplayOffset;
    }

    if (typeof options.refresh === "boolean") {
      params.refresh = options.refresh;
    }

    return params;
  }

  private mapLoadOptions(options: BrowseLoadOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
      item_key: options.itemKey,
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

  private mapPopOptions(options: BrowsePopOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
    };

    if (options.zoneId) {
      params.zone_or_output_id = options.zoneId;
    }

    if (typeof options.levels === "number") {
      params.level = options.levels;
    }

    return params;
  }

  private normalizeResult(payload: any): BrowseResult {
    const list = payload?.list ?? {};
    const items = Array.isArray(list.items) ? list.items : [];

    const normalizedItems = items.map((item: any) => this.toBrowseItem(item));

    return {
      title: list.title ?? payload?.title,
      level: this.ensureNumber(list.level ?? payload?.level, 0),
      offset: this.ensureNumber(list.offset ?? payload?.offset, 0),
      count: this.ensureNumber(list.count ?? normalizedItems.length, normalizedItems.length),
      totalCount: this.ensureOptionalNumber(list.total_count ?? list.count),
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
      isLoadable: Boolean(item?.is_loadable),
      isPlayable: Boolean(item?.is_playable),
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
