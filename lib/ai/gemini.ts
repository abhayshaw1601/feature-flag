import { z } from "zod";
import type { AiConfig } from "./config";
import { AiError } from "./errors";

export type AiUsage = { tokensIn: number; tokensOut: number };
export type Completion = AiUsage & { text: string };
export type GeminiRequest = {
  model: string;
  system: string;
  user: string;
  jsonSchema: object;
  signal?: AbortSignal;
};
export interface AiTransport {
  generate(request: GeminiRequest): Promise<Completion>;
  stream(request: GeminiRequest): AsyncIterable<Completion>;
}

const envelopeSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }))
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      thoughtsTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

function decodeEnvelope(value: unknown): Completion & { finished: boolean } {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success)
    throw new AiError("AI_PROVIDER_RESPONSE", "Gemini returned an unreadable response.");
  const data = parsed.data;
  const candidate = data.candidates?.[0];
  if (
    data.promptFeedback?.blockReason ||
    (candidate?.finishReason && candidate.finishReason !== "STOP")
  ) {
    throw new AiError(
      "AI_INCOMPLETE_OUTPUT",
      "Gemini could not finish a valid response. Please revise the request.",
    );
  }
  return {
    finished: candidate?.finishReason === "STOP",
    text:
      candidate?.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("") ?? "",
    tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOut:
      (data.usageMetadata?.candidatesTokenCount ?? 0) +
      (data.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}

const MAX_RESPONSE_CHARS = 1_000_000;

/** One transport attempt. The structured helper owns the shared, one-retry budget. */
export function createGeminiTransport(
  config: AiConfig,
  fetcher: typeof fetch = fetch,
): AiTransport {
  async function* request(input: GeminiRequest, streaming: boolean): AsyncGenerator<Completion> {
    if (!/^gemini-[a-z0-9][a-z0-9._-]*$/.test(input.model)) {
      throw new AiError("AI_CONFIGURATION", "Only Gemini models are supported.", 503);
    }
    if (!config.apiKey)
      throw new AiError(
        "AI_CONFIGURATION",
        "Live AI requires a Gemini API key on the server.",
        503,
      );
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const method = streaming ? "streamGenerateContent?alt=sse" : "generateContent";
      const response = await fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.system }] },
            contents: [{ role: "user", parts: [{ text: input.user }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: input.jsonSchema,
              maxOutputTokens: 8192,
            },
          }),
          signal,
          cache: "no-store",
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AiError(
          "AI_PROVIDER_ERROR",
          "Gemini is temporarily unavailable. Please try again.",
          502,
          response.status === 429 || response.status >= 500,
        );
      }
      if (!response.body)
        throw new AiError("AI_PROVIDER_RESPONSE", "Gemini returned an empty response.", 502, true);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let total = 0;
      let done = false;
      let finished = false;
      while (!done) {
        const part = await reader.read();
        done = part.done;
        buffer += decoder.decode(part.value, { stream: !done });
        total += part.value?.length ?? 0;
        if (total > MAX_RESPONSE_CHARS)
          throw new AiError(
            "AI_OUTPUT_TOO_LARGE",
            "The generated response exceeded the size limit.",
          );
        if (streaming) {
          // Normalize complete SSE frames only; handles CRLF split across network chunks.
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data && data !== "[DONE]") {
              const chunk = decodeEnvelope(JSON.parse(data));
              finished ||= chunk.finished;
              yield chunk;
            }
          }
        }
      }
      if (!streaming) {
        const completion = decodeEnvelope(JSON.parse(buffer));
        if (!completion.finished)
          throw new AiError(
            "AI_INCOMPLETE_OUTPUT",
            "Gemini did not finish its response.",
            502,
            true,
          );
        yield completion;
      } else if (buffer.trim() || !finished)
        throw new AiError("AI_TRUNCATED_STREAM", "The AI response was interrupted.", 502, true);
    } catch (error) {
      if (input.signal?.aborted)
        throw new AiError("AI_CANCELLED", "The AI request was cancelled.", 499);
      if (timeout.signal.aborted)
        throw new AiError("AI_TIMEOUT", "Gemini did not respond within 30 seconds.", 504, true);
      if (error instanceof AiError) throw error;
      throw new AiError("AI_NETWORK_ERROR", "Could not read a response from Gemini.", 502, true);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }
  return {
    async generate(input) {
      for await (const chunk of request(input, false)) return chunk;
      throw new AiError("AI_PROVIDER_RESPONSE", "Gemini returned an empty response.");
    },
    stream: (input) => request(input, true),
  };
}
