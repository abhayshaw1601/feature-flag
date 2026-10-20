export class AiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
    public readonly retryable = false,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

// Never surface provider response bodies, request headers, or database errors.
export function safeAiError(error: unknown): AiError {
  return error instanceof AiError
    ? error
    : new AiError("AI_UNAVAILABLE", "The AI service is unavailable. Please try again.", 503);
}
