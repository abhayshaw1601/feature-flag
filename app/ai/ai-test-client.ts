import { apiErrorSchema, createApiSuccessSchema } from "@flagforge/contracts";
import { z } from "zod";

// Validate the demo's wire format at the browser boundary, including run metadata.
const aiTestResultSchema = z.object({
  output: z.object({
    message: z.string(),
    insufficientData: z.boolean(),
  }),
  runId: z.string().min(1),
  model: z.string().min(1),
  mock: z.boolean(),
  promptVersion: z.string().min(1),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
});
const aiTestResponseSchema = createApiSuccessSchema(aiTestResultSchema);

export type AiTestResult = z.infer<typeof aiTestResultSchema>;

export class AiTestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AiTestError";
  }
}

export async function requestAiTest(
  workspaceId: string,
  message: string,
  signal?: AbortSignal,
): Promise<AiTestResult> {
  let response: Response;
  try {
    response = await fetch("/api/ai/test", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, message }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AiTestError(
      "Could not reach the AI service. Check your connection and try again.",
      "NETWORK_ERROR",
    );
  }

  const body: unknown = await response.json().catch(() => null);
  signal?.throwIfAborted();

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new AiTestError(parsed.data.error.message, parsed.data.error.code);
    }
    const fallback =
      response.status === 401
        ? "Your session has expired. Sign in and try again."
        : response.status === 429
          ? "Too many AI requests. Wait a moment before retrying."
          : "The AI request failed. Please try again.";
    throw new AiTestError(fallback, "REQUEST_FAILED");
  }

  const parsed = aiTestResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AiTestError(
      "The AI service returned an unexpected response. Please try again.",
      "INVALID_RESPONSE",
    );
  }
  return parsed.data.data;
}
