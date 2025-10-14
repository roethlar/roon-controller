/**
 * Roon Error Hierarchy
 *
 * Typed error classes for Roon Controller operations
 */

/**
 * Base error class for all Roon-related errors
 */
export class RoonError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error thrown when attempting operations without a paired Roon core
 */
export class CoreUnpairedError extends RoonError {
  constructor(message: string = "Roon core not paired") {
    super(message, "CORE_UNPAIRED", 503);
  }
}

/**
 * Error thrown when a required Roon service is unavailable
 */
export class ServiceUnavailableError extends RoonError {
  public readonly serviceName: string;

  constructor(serviceName: string, message?: string) {
    super(
      message || `Roon service '${serviceName}' is unavailable`,
      "SERVICE_UNAVAILABLE",
      503
    );
    this.serviceName = serviceName;
  }
}

/**
 * Error thrown when requested image is not found
 */
export class ImageNotFoundError extends RoonError {
  public readonly imageKey: string;

  constructor(imageKey: string) {
    super(`Image not found: ${imageKey}`, "IMAGE_NOT_FOUND", 404);
    this.imageKey = imageKey;
  }
}

/**
 * Error thrown when Roon operation fails
 */
export class RoonOperationError extends RoonError {
  public readonly operation: string;
  public readonly context?: Record<string, unknown>;

  constructor(
    operation: string,
    message: string,
    context?: Record<string, unknown>
  ) {
    super(`${operation} failed: ${message}`, "OPERATION_FAILED", 500);
    this.operation = operation;
    this.context = context;
  }
}
