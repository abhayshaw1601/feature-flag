import { apiErrorSchema } from "@flagforge/contracts";
import type { ZodType } from "zod";

export class FlagApiError extends Error {
  constructor(
    message: string,
    public readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = "FlagApiError";
  }
}

export async function requestFlagData<T>(
  url: string,
  schema: ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body);
    throw new FlagApiError(
      error.success ? error.data.error.message : `Request failed (${response.status}). Try again.`,
      error.success ? error.data.error.fieldErrors : undefined,
    );
  }
  const data = schema.safeParse(
    body && typeof body === "object" && "data" in body ? body.data : undefined,
  );
  if (!data.success)
    throw new FlagApiError("The server returned an unexpected response. Try again.");
  return data.data;
}

export function requestErrorMessage(error: unknown) {
  return error instanceof FlagApiError
    ? error.message
    : "Could not reach the server. Check your connection and try again.";
}
