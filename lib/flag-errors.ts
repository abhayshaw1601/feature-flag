/** Expected errors safe to send to a client. Never attach database errors or request bodies. */
export class FlagServiceError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "FlagServiceError";
  }
}
