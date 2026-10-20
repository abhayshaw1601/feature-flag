import type { z } from "zod";
import type { AiConfig } from "./config";
import { AiError, safeAiError } from "./errors";
import { createGeminiTransport, type AiTransport, type AiUsage } from "./gemini";
import { renderAiPrompt, type AiPrompt } from "./prompts";
import { redactAiLog, sanitizeAiOutput } from "./sanitize";
import { generateStructured } from "./structured";

export type RunContext = { workspaceId: string; userId: string };
export type RunReservation = RunContext & {
  feature: string;
  model: string;
  input: unknown;
  dailyLimit: number;
};
export type RunCompletion = AiUsage & {
  status: "SUCCEEDED" | "FAILED";
  output?: unknown;
  error?: string;
  latencyMs: number;
};
export interface AiRunStore {
  reserve(input: RunReservation): Promise<string>;
  finish(id: string, result: RunCompletion): Promise<void>;
}

export type RunAiOptions<T extends z.ZodTypeAny> = {
  context: RunContext;
  prompt: AiPrompt<T>;
  input: unknown;
  /** Required safe metadata, not raw user text, secrets, or source code. */
  logInput: Record<string, unknown>;
  config: AiConfig;
  store: AiRunStore;
  transport?: AiTransport;
  signal?: AbortSignal;
  streaming?: boolean;
  onProgress?: (receivedChars: number) => void;
};

/** Common entry point for features: limits and logging apply equally in mock/live mode. */
export async function runAi<T extends z.ZodTypeAny>(options: RunAiOptions<T>) {
  const { prompt, config, store } = options;
  const model = config.models[prompt.tier];
  const started = Date.now();
  const runId = await store.reserve({
    ...options.context,
    feature: prompt.feature,
    model,
    dailyLimit: config.dailyWorkspaceCallLimit,
    input: redactAiLog({
      metadata: options.logInput,
      promptId: prompt.id,
      promptVersion: prompt.version,
      mock: config.mock,
    }),
  });
  const usage: AiUsage = { tokensIn: 0, tokensOut: 0 };
  let output: z.output<T>;
  try {
    if (options.signal?.aborted)
      throw new AiError("AI_CANCELLED", "The AI request was cancelled.", 499);
    if (config.mock) {
      const parsed = prompt.schema.safeParse(sanitizeAiOutput(prompt.fixture));
      if (!parsed.success)
        throw new AiError(
          "AI_INVALID_FIXTURE",
          "The AI mock fixture did not pass validation.",
          500,
        );
      output = parsed.data;
    } else {
      output = await generateStructured({
        schema: prompt.schema,
        transport: options.transport ?? createGeminiTransport(config),
        request: { ...renderAiPrompt(prompt, options.input), model, signal: options.signal },
        streaming: options.streaming,
        onProgress: options.onProgress,
        onUsage: (attempt) => {
          usage.tokensIn += attempt.tokensIn;
          usage.tokensOut += attempt.tokensOut;
        },
      });
    }
  } catch (error) {
    const safe = safeAiError(error);
    await store.finish(runId, {
      status: "FAILED",
      error: safe.code,
      latencyMs: Date.now() - started,
      ...usage,
    });
    throw safe;
  }
  const latencyMs = Date.now() - started;
  // Fail closed if a completed run cannot be recorded; never return an unlogged success.
  await store.finish(runId, {
    status: "SUCCEEDED",
    output: redactAiLog(output),
    latencyMs,
    ...usage,
  });
  return {
    output,
    runId,
    model,
    mock: config.mock,
    promptVersion: prompt.version,
    latencyMs,
    ...usage,
  };
}
