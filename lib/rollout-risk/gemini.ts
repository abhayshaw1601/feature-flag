import { rolloutRiskOutputSchema, type RolloutRiskOutput } from "@flagforge/contracts";
import { z } from "zod";
import { rolloutRiskPromptV1 } from "../../prompts/rollout-risk.v1";
import type { RolloutRiskInput } from "./types";

const envelopeSchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.literal("STOP"),
        content: z.object({
          parts: z.array(
            z.object({ text: z.string().optional(), thought: z.boolean().optional() }),
          ),
        }),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      thoughtsTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type RiskGeneration = { output: RolloutRiskOutput; tokensIn: number; tokensOut: number };

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) {
        cancel();
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new Error("TIMEOUT");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Phase 6's replaceable provider adapter. Its total model budget is 3 seconds, not 30. */
export async function generateRiskWithGemini(
  input: RolloutRiskInput,
  facts: RolloutRiskOutput,
  options: { model: string; apiKey: string; fetch?: typeof fetch; attemptMs?: number },
): Promise<RiskGeneration> {
  if (!/^gemini-[a-z0-9][a-z0-9.-]{0,90}$/.test(options.model) || !options.apiKey.trim()) {
    throw new Error("AI_CONFIGURATION_ERROR");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const attemptMs = Math.min(1500, options.attemptMs ?? 1500);
  if (!Number.isFinite(attemptMs) || attemptMs <= 0) throw new Error("INVALID_TIMEOUT");
  let validationFeedback = "";
  let tokensIn = 0;
  let tokensOut = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("TIMEOUT"));
      }, attemptMs);
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          const response = await fetcher(
            `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`,
            {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
              body: JSON.stringify({
                systemInstruction: {
                  parts: [{ text: rolloutRiskPromptV1.system + validationFeedback }],
                },
                contents: [
                  { role: "user", parts: [{ text: rolloutRiskPromptV1.user(input, facts) }] },
                ],
                generationConfig: {
                  temperature: 0,
                  maxOutputTokens: 4096,
                  responseMimeType: "application/json",
                },
              }),
            },
          );
          if (controller.signal.aborted || !response.ok) {
            void response.body?.cancel().catch(() => undefined);
            throw new Error("PROVIDER_ERROR");
          }
          const envelope = envelopeSchema.parse(await readBoundedJson(response, controller.signal));
          tokensIn += envelope.usageMetadata?.promptTokenCount ?? 0;
          tokensOut +=
            (envelope.usageMetadata?.candidatesTokenCount ?? 0) +
            (envelope.usageMetadata?.thoughtsTokenCount ?? 0);
          const text = envelope.candidates[0].content.parts
            .filter((part) => !part.thought)
            .map((part) => part.text ?? "")
            .join("");
          const parsed = rolloutRiskOutputSchema.safeParse(JSON.parse(text));
          if (!parsed.success) {
            // Schema paths and issue codes only, never echo arbitrary provider content.
            validationFeedback = `\nPrevious JSON failed validation: ${parsed.error.issues
              .slice(0, 6)
              .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
              .join("; ")}. Return corrected JSON.`;
            throw new Error("INVALID_OUTPUT");
          }
          return { output: parsed.data, tokensIn, tokensOut };
        })(),
      ]);
    } catch {
      if (!validationFeedback)
        validationFeedback =
          "\nThe previous attempt failed. Return one complete valid JSON object in the specified shape.";
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  // Deliberately exclude provider response bodies, URLs with credentials, and raw errors.
  throw new Error("GENERATION_UNAVAILABLE");
}
