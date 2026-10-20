import { z } from "zod";
import { AiError, safeAiError } from "./errors";

export const aiTestRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(4000),
  })
  .strict();

type TestHandlerDependencies = {
  authorize: (workspaceId: string) => Promise<{ userId: string }>;
  run: (
    input: z.infer<typeof aiTestRequestSchema>,
    userId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export function createAiTestHandler(deps: TestHandlerDependencies) {
  return async function POST(request: Request) {
    try {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin)
        throw new AiError("AI_ORIGIN", "Cross-origin AI requests are not allowed.", 403);
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new AiError("AI_CONTENT_TYPE", "Send an application/json request.", 415);
      }
      // Bound actual bytes, not just the caller-supplied Content-Length header.
      const reader = request.body?.getReader();
      if (!reader) throw new AiError("AI_BAD_REQUEST", "Provide a workspace ID and message.", 400);
      let text = "";
      let size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          size += value?.byteLength ?? 0;
          if (size > 20000)
            throw new AiError("AI_BODY_TOO_LARGE", "The AI request is too large.", 413);
          text += decoder.decode(value, { stream: !done });
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AiError("AI_BAD_REQUEST", "Send a valid JSON request.", 400);
      }
      const parsed = aiTestRequestSchema.safeParse(body);
      if (!parsed.success)
        throw new AiError(
          "AI_BAD_REQUEST",
          "Provide a workspace ID and a message of 1 to 4,000 characters.",
          400,
        );
      const { userId } = await deps.authorize(parsed.data.workspaceId);
      const result = await deps.run(parsed.data, userId, request.signal);
      return Response.json({ data: result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const safe = safeAiError(error);
      return Response.json(
        { error: { code: safe.code, message: safe.message } },
        {
          status: safe.status,
          headers: {
            "Cache-Control": "no-store",
            ...(safe.retryAfter ? { "Retry-After": String(safe.retryAfter) } : {}),
          },
        },
      );
    }
  };
}
