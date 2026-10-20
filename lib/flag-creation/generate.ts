import { z } from "zod";
import { flagCreationPromptV1 } from "../../prompts/flag-creation.v1";
import { generateMockFlagDraft } from "./fixtures";
import {
  FlagCreationError,
  flagCreationRequestSchema,
  type FlagCreationContext,
  type FlagCreationDependencies,
  type FlagCreationResult,
} from "./types";
import { validateFlagCreationContext, validateFlagDraft } from "./validation";

export { FlagCreationError } from "./types";
export type { FlagCreationContext, FlagCreationDependencies, FlagCreationResult } from "./types";

const MAX_RESPONSE_BYTES = 131072;
const providerEnvelopeSchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z.object({
          parts: z
            .array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }))
            .min(1),
        }),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().max(10_000_000).optional(),
      candidatesTokenCount: z.number().int().nonnegative().max(10_000_000).optional(),
      thoughtsTokenCount: z.number().int().nonnegative().max(10_000_000).optional(),
    })
    .optional(),
});

/** Race the full operation (including body reads), even if an injected fetch ignores abort. */
async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortParent: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const abort = () => {
      reject(new FlagCreationError("GENERATION_TIMEOUT"));
      controller.abort();
    };
    timer = setTimeout(abort, timeoutMs);
    abortParent = abort;
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
  });
  try {
    if (controller.signal.aborted) throw new FlagCreationError("GENERATION_TIMEOUT");
    return await Promise.race([deadline, operation(controller.signal)]);
  } finally {
    clearTimeout(timer);
    if (abortParent) parent?.removeEventListener("abort", abortParent);
  }
}

async function readProviderJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new FlagCreationError("PROVIDER_ERROR");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new FlagCreationError("GENERATION_TIMEOUT");
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new FlagCreationError("GENERATION_TIMEOUT");
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        throw new FlagCreationError("INVALID_OUTPUT");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new FlagCreationError("INVALID_OUTPUT");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Server-only, replaceable Phase 5 adapter. No persistence or authorization is
 * performed here: callers must authorize the project and build trusted context.
 * Live calls use Gemini generateContent; tests inject fetch and never need keys.
 */
export async function generateFlagDraft(
  input: { prompt: string; context: FlagCreationContext },
  dependencies: FlagCreationDependencies = {},
): Promise<FlagCreationResult> {
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const promptResult = flagCreationRequestSchema.shape.prompt.safeParse(input?.prompt);
  if (!promptResult.success) throw new FlagCreationError("INVALID_REQUEST");
  const prompt = promptResult.data;
  const context = validateFlagCreationContext(input?.context);
  const env = dependencies.env ?? process.env;
  const provider = env.AI_PROVIDER ?? "google";
  const model = env.LLM_MODEL_REASONING ?? "gemini-2.5-pro";
  if (
    provider !== "google" ||
    model.length > 100 ||
    !/^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(model)
  ) {
    throw new FlagCreationError("AI_CONFIGURATION_ERROR");
  }
  const mock = env.AI_MOCK === "true";
  let tokensIn = 0;
  let tokensOut = 0;
  const result = (draft: FlagCreationResult["draft"]): FlagCreationResult => ({
    draft,
    model: mock ? `mock:${flagCreationPromptV1.version}` : model,
    mock,
    latencyMs: Math.max(0, Math.round(now() - started)),
    tokensIn,
    tokensOut,
  });
  if (mock) return result(generateMockFlagDraft(prompt, context));
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey?.trim()) throw new FlagCreationError("AI_CONFIGURATION_ERROR");
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = Math.min(30_000, dependencies.timeoutMs ?? 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new FlagCreationError("AI_CONFIGURATION_ERROR");

  return withDeadline(async (totalSignal) => {
    let previousError: FlagCreationError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (totalSignal.aborted) throw new FlagCreationError("GENERATION_TIMEOUT");
      try {
        // Reserve half the total budget for a retry, including a first-attempt timeout.
        return await withDeadline(
          async (signal) => {
            const retry = previousError
              ? `\nThe previous attempt failed: ${previousError.code}. ${previousError.message} Correct that issue and return a complete replacement JSON object. Do not repeat the invalid draft.`
              : "";
            const response = await fetcher(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: "POST",
                redirect: "error",
                headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
                signal,
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: flagCreationPromptV1.system + retry }] },
                  contents: [
                    {
                      role: "user",
                      parts: [{ text: flagCreationPromptV1.userTemplate(prompt, context) }],
                    },
                  ],
                  generationConfig: {
                    temperature: 0,
                    maxOutputTokens: 8192,
                    responseMimeType: "application/json",
                  },
                }),
              },
            );
            if (signal.aborted) {
              void response.body?.cancel().catch(() => undefined);
              throw new FlagCreationError("GENERATION_TIMEOUT");
            }
            if (!response.ok) {
              void response.body?.cancel().catch(() => undefined);
              throw new FlagCreationError("PROVIDER_ERROR");
            }
            const envelope = providerEnvelopeSchema.safeParse(
              await readProviderJson(response, signal),
            );
            if (!envelope.success) throw new FlagCreationError("INVALID_OUTPUT");
            tokensIn += envelope.data.usageMetadata?.promptTokenCount ?? 0;
            tokensOut +=
              (envelope.data.usageMetadata?.candidatesTokenCount ?? 0) +
              (envelope.data.usageMetadata?.thoughtsTokenCount ?? 0);
            const candidate = envelope.data.candidates[0];
            if (candidate.finishReason && candidate.finishReason !== "STOP")
              throw new FlagCreationError("INVALID_OUTPUT");
            const text = candidate.content.parts
              .filter((part) => !part.thought)
              .map((part) => part.text ?? "")
              .join("");
            let output: unknown;
            try {
              output = JSON.parse(text);
            } catch {
              throw new FlagCreationError("INVALID_OUTPUT");
            }
            if (
              z
                .object({ error: z.literal("INSUFFICIENT_CONTEXT") })
                .strict()
                .safeParse(output).success
            ) {
              throw new FlagCreationError("INSUFFICIENT_CONTEXT");
            }
            const draft = validateFlagDraft(output, context, prompt);
            return result(draft);
          },
          timeoutMs / 2,
          totalSignal,
        );
      } catch (error) {
        previousError =
          error instanceof FlagCreationError ? error : new FlagCreationError("PROVIDER_ERROR");
        if (totalSignal.aborted) throw new FlagCreationError("GENERATION_TIMEOUT");
      }
    }
    throw previousError ?? new FlagCreationError("INVALID_OUTPUT");
  }, timeoutMs);
}
