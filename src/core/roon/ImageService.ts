/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "pino";
import { Readable } from "stream";
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

  constructor(
    private roonClient: RoonClient,
    private logger: Logger
  ) {}

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
  ): Promise<{ stream: Readable; contentType: string }> {
    this.ensureImage();

    // Validate width/height when scale is provided (Roon API requirement)
    if (scale && (!width || !height)) {
      const error = new Error("width and height are required when scale is specified");
      this.logger.error({ imageKey, scale, width, height }, "Invalid getImage parameters");
      throw error;
    }

    return new Promise((resolve, reject) => {
      const options: any = { image_key: imageKey };

      if (scale) options.scale = scale;
      if (width) options.width = width;
      if (height) options.height = height;

      this.image.get_image(options, (error: any, contentType: string, imageStream: any) => {
        if (error) {
          this.logger.error({ err: error, imageKey }, "getImage failed");
          reject(new RoonOperationError("getImage", error, { imageKey }));
        } else if (!imageStream) {
          this.logger.warn({ imageKey }, "Image not found");
          reject(new ImageNotFoundError(imageKey));
        } else {
          this.logger.debug({ imageKey, contentType }, "Image retrieved");
          resolve({ stream: imageStream, contentType });
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
