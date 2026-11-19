export class EngineSpecError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EngineSpecError";
  }
}

