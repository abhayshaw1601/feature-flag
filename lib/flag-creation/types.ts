import type { FlagCreationOutput } from "@flagforge/contracts";
import { z } from "zod";

/** Supplied by the server after project authorization, including archived keys. */
export type FlagCreationContext = {
  existingFlagKeys: string[];
  knownUserAttributes: string[];
  environments: Array<{ key: string; name: string }>;
  allowProduction: boolean;
};

export const flagCreationRequestSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    prompt: z.string().trim().min(10).max(2000),
    allowProduction: z.boolean().default(false),
  })
  .strict();

export type FlagCreationRequest = z.infer<typeof flagCreationRequestSchema>;
export type FlagCreationResult = {
  draft: FlagCreationOutput;
  model: string;
  mock: boolean;
  latencyMs: number;
  /** Provider-reported usage summed over both attempts; zero in mock mode. */
  tokensIn: number;
  /** Includes Gemini reasoning tokens when reported. */
  tokensOut: number;
};

export type FlagCreationDependencies = {
  fetch?: typeof globalThis.fetch;
  /** Replaces, rather than merges with, process.env when supplied. */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Total deadline across attempts. Tests can shorten it; never exceeds 30 seconds. */
  timeoutMs?: number;
};

const errors = {
  INVALID_REQUEST: [400, "Enter a flag description between 10 and 2000 characters."],
  INVALID_CONTEXT: [400, "The project context is invalid or exceeds generation limits."],
  AI_CONFIGURATION_ERROR: [503, "Flag generation requires a configured Google Gemini model."],
  INSUFFICIENT_CONTEXT: [
    422,
    "There is insufficient information to generate this flag. Clarify the request or project context.",
  ],
  INVALID_OUTPUT: [
    502,
    "The generated draft did not meet the flag validation requirements. Try again.",
  ],
  DUPLICATE_FLAG_KEY: [
    502,
    "The generated flag key already exists, including archived flags. Try again.",
  ],
  UNKNOWN_ENVIRONMENT: [502, "The generated draft references an unknown environment. Try again."],
  UNKNOWN_ATTRIBUTE: [502, "The generated draft references an unknown user attribute. Try again."],
  DUPLICATE_RULE_ID: [502, "The generated draft contains duplicate rule identifiers. Try again."],
  PRODUCTION_NOT_ALLOWED: [
    502,
    "Production must remain disabled without explicit opt-in and an affirmative production request.",
  ],
  PROVIDER_ERROR: [502, "The generation provider could not complete the request. Try again."],
  GENERATION_TIMEOUT: [504, "Flag generation timed out. Try again."],
} as const;

export type FlagCreationErrorCode = keyof typeof errors;

/** Only fixed, safe messages cross this boundary; never provider bodies or credentials. */
export class FlagCreationError extends Error {
  readonly status: number;
  readonly code: FlagCreationErrorCode;

  constructor(code: FlagCreationErrorCode) {
    super(errors[code][1]);
    this.name = "FlagCreationError";
    this.status = errors[code][0];
    this.code = code;
  }
}
