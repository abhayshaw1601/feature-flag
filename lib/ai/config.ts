import { z } from "zod";
import { AiError } from "./errors";

export type ModelTier = "reasoning" | "fast";
export type AiConfig = {
  mock: boolean;
  apiKey?: string;
  models: Record<ModelTier, string>;
  dailyWorkspaceCallLimit: number;
  timeoutMs: number;
};

const modelSchema = z.string().regex(/^gemini-[a-z0-9][a-z0-9._-]*$/);
const envSchema = z.object({
  AI_PROVIDER: z.literal("google").default("google"),
  AI_MOCK: z.enum(["true", "false"]).default("true"),
  GEMINI_API_KEY: z.string().optional(),
  LLM_MODEL_REASONING: modelSchema.default("gemini-2.5-pro"),
  LLM_MODEL_FAST: modelSchema.default("gemini-2.5-flash"),
  AI_DAILY_WORKSPACE_CALL_LIMIT: z.coerce.number().int().min(1).max(100000).default(200),
});

export function getAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new AiError("AI_CONFIGURATION", "Check the server's Gemini AI configuration.", 503);
  }
  const config = result.data;
  if (
    config.AI_MOCK === "false" &&
    (!config.GEMINI_API_KEY?.trim() || config.GEMINI_API_KEY.startsWith("replace-with-"))
  ) {
    throw new AiError("AI_CONFIGURATION", "Live AI requires a Gemini API key on the server.", 503);
  }
  return {
    mock: config.AI_MOCK === "true",
    apiKey: config.GEMINI_API_KEY,
    models: { reasoning: config.LLM_MODEL_REASONING, fast: config.LLM_MODEL_FAST },
    dailyWorkspaceCallLimit: config.AI_DAILY_WORKSPACE_CALL_LIMIT,
    timeoutMs: 30000,
  };
}
