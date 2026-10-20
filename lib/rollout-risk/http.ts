import { z } from "zod";
import { RolloutRiskError } from "./service";

/** Bound streamed bodies too: Content-Length is optional and cannot be trusted. */
export async function readRiskRequest(request: Request): Promise<unknown> {
  if (!request.body)
    throw new RolloutRiskError(400, "INVALID_JSON", "A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        void reader.cancel().catch(() => undefined);
        throw new RolloutRiskError(413, "REQUEST_TOO_LARGE", "The proposed change is too large.");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RolloutRiskError(400, "INVALID_JSON", "Send a valid JSON request body.");
    }
  } finally {
    reader.releaseLock();
  }
}

export function riskResponse(data: unknown) {
  return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
}

export function riskErrorResponse(error: unknown) {
  const failure =
    error instanceof RolloutRiskError
      ? error
      : error instanceof z.ZodError
        ? new RolloutRiskError(
            400,
            "VALIDATION_ERROR",
            "Check the change: percentages must be whole numbers from 0 to 100 and match the default serve.",
          )
        : new RolloutRiskError(
            500,
            "ASSESSMENT_UNAVAILABLE",
            "The assessment could not be completed. Please retry.",
          );
  return Response.json(
    { error: { code: failure.code, message: failure.message } },
    {
      status: failure.status,
      headers: {
        "Cache-Control": "no-store",
        ...(failure.status === 429 ? { "Retry-After": "60" } : {}),
      },
    },
  );
}
