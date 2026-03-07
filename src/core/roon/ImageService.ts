/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { Logger } from "pino";
import { RoonClient } from "./RoonClient";
import { CoreUnpairedError, ImageNotFoundError, RoonOperationError } from "./errors";

/**
 * Image Service
 *
 * Provides artwork streaming by image key from Roon.
 * Handles image retrieval with appropriate caching headers.
 */
export class ImageService {
  private image: any | null = null;
  private readonly cacheDir: string;

  constructor(
    private roonClient: RoonClient,
    private logger: Logger,
    cacheDir: string
  ) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.logger.info({ cacheDir: this.cacheDir }, "Image cache directory initialized");
  }

  /**
   * Initialize image service
   */
  public start(): void {
    this.image = this.roonClient.getImage();

    if (!this.image) {
      this.logger.warn("Image service not available yet, will retry on core pairing");
      return;
    }

    this.logger.info("ImageService started");
  }

  /**
   * Get image stream by key
   * @param imageKey - Roon image key
   * @param scale - Optional scale (fit, fill, stretch)
   * @param width - Optional width in pixels
   * @param height - Optional height in pixels
   * @returns Promise resolving to image stream and content type
   */
  public async getImage(
    imageKey: string,
    scale?: "fit" | "fill" | "stretch",
    width?: number,
    height?: number
  ): Promise<{ data: Buffer; contentType: string }> {
    this.ensureImage();

    // Validate width/height when scale is provided (Roon API requirement)
    if (scale && (!width || !height)) {
      const error = new Error("width and height are required when scale is specified");
      this.logger.error({ imageKey, scale, width, height }, "Invalid getImage parameters");
      throw error;
    }

    // Build a cache key from imageKey + scale parameters
    const cacheKey = scale
      ? `${imageKey}_${scale}_${width}x${height}`
      : imageKey;
    const cachePath = path.join(this.cacheDir, cacheKey);
    const metaPath = cachePath + ".meta";

    // Check disk cache
    try {
      const [data, contentType] = await Promise.all([
        fs.promises.readFile(cachePath),
        fs.promises.readFile(metaPath, "utf-8"),
      ]);
      this.logger.debug({ imageKey, cacheKey }, "Image served from cache");
      return { data, contentType: contentType.trim() };
    } catch {
      // Cache miss — fetch from Roon
    }

    const result = await this.fetchFromRoon(imageKey, scale, width, height);

    // Write to cache (fire-and-forget, don't block the response)
    fs.promises
      .writeFile(cachePath, result.data)
      .then(() => fs.promises.writeFile(metaPath, result.contentType))
      .catch((err) =>
        this.logger.warn({ err, cacheKey }, "Failed to write image cache")
      );

    return result;
  }

  private fetchFromRoon(
    imageKey: string,
    scale?: "fit" | "fill" | "stretch",
    width?: number,
    height?: number
  ): Promise<{ data: Buffer; contentType: string }> {
    return new Promise((resolve, reject) => {
      const options: Record<string, unknown> = {};
      if (scale) options.scale = scale;
      if (width) options.width = width;
      if (height) options.height = height;

      this.image.get_image(imageKey, options, (error: any, contentType: string, imageData: Buffer) => {
        if (error) {
          this.logger.error({ err: error, imageKey }, "getImage failed");
          reject(new RoonOperationError("getImage", error, { imageKey }));
        } else if (!imageData) {
          this.logger.warn({ imageKey }, "Image not found");
          reject(new ImageNotFoundError(imageKey));
        } else {
          this.logger.debug({ imageKey, contentType }, "Image retrieved from Roon");
          resolve({ data: imageData, contentType });
        }
      });
    });
  }

  /**
   * Get cache control headers for image responses
   * Images from Roon are generally static, so we can cache aggressively
   */
  public getCacheHeaders(): Record<string, string> {
    return {
      "Cache-Control": "public, max-age=86400, immutable", // 24 hours
      "Vary": "Accept-Encoding",
    };
  }

  /**
   * Ensure image service is available
   * @throws Error if core not paired or image service unavailable
   */
  private ensureImage(): void {
    this.image = this.roonClient.getImage();

    if (!this.image) {
      this.logger.error("Image operation attempted without paired core");
      throw new CoreUnpairedError("Image service unavailable");
    }
  }
}
