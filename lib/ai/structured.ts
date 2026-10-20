import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AiError } from "./errors";
import type { AiTransport, AiUsage, Completion, GeminiRequest } from "./gemini";
import { sanitizeAiOutput } from "./sanitize";

export type StructuredOptions<T extends z.ZodTypeAny> = {
  schema: T;
  transport: AiTransport;
  request: Omit<GeminiRequest, "jsonSchema">;
  streaming?: boolean;
  onProgress?: (receivedChars: number) => void;
  onUsage?: (usage: AiUsage) => void;
};

export async function generateStructured<T extends z.ZodTypeAny>(options: StructuredOptions<T>) {
  const jsonSchema = zodToJsonSchema(options.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  });
  const { $schema: _schema, ...providerSchema } = jsonSchema;
  void _schema;
  let user = options.request.user;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (options.request.signal?.aborted)
      throw new AiError("AI_CANCELLED", "The AI request was cancelled.", 499);
    let completion: Completion = { text: "", tokensIn: 0, tokensOut: 0 };
    try {
      const request = { ...options.request, user, jsonSchema: providerSchema };
      if (options.streaming) {
        completion = { text: "", tokensIn: 0, tokensOut: 0 };
        for await (const chunk of options.transport.stream(request)) {
          completion.text += chunk.text;
          completion.tokensIn = Math.max(completion.tokensIn, chunk.tokensIn);
          completion.tokensOut = Math.max(completion.tokensOut, chunk.tokensOut);
          // Never display or apply unvalidated partial JSON. Later chat may use the raw transport.
          options.onProgress?.(completion.text.length);
        }
      } else {
        completion = await options.transport.generate(request);
      }
    } catch (error) {
      if (options.streaming) {
        options.onUsage?.({ tokensIn: completion.tokensIn, tokensOut: completion.tokensOut });
      }
      if (attempt === 0 && error instanceof AiError && error.retryable) continue;
      throw error;
    }
    options.onUsage?.({ tokensIn: completion.tokensIn, tokensOut: completion.tokensOut });
    let parsed: unknown;
    let validationError = "Response must be a JSON object without Markdown fences.";
    try {
      parsed = JSON.parse(completion.text);
      const validated = options.schema.safeParse(sanitizeAiOutput(parsed));
      if (validated.success) return validated.data as z.output<T>;
      // Paths/codes communicate errors without echoing user data or provider output back into prompts.
      validationError = validated.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.code}`)
        .join("; ");
    } catch {
      // A malformed JSON response receives the same single correction attempt as a schema error.
    }
    if (attempt === 1)
      throw new AiError(
        "AI_INVALID_OUTPUT",
        "Gemini could not produce valid structured output after one retry. Please try again.",
      );
    user = `${options.request.user}\n\nYour previous output failed validation: ${validationError}\nReturn a corrected JSON response matching the schema.`;
  }
  throw new AiError("AI_INVALID_OUTPUT", "Gemini could not produce a valid response.");
}
