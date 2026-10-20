import {
  conditionSchema,
  flagCreationOutputSchema,
  ruleSchema,
  ruleSetSchema,
  serveSchema,
  type FlagCreationOutput,
} from "@flagforge/contracts";
import { z } from "zod";
import { FlagCreationError, type FlagCreationContext } from "./types";

// Remove full keycap sequences before their combining marks, preserving ordinary digits.
const emoji =
  /[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;
const controls = /[\p{Cc}\p{Cf}]/gu;

export function sanitizeFlagText(value: string): string {
  return value.replace(emoji, "").replace(controls, " ").replace(/\s+/gu, " ").trim();
}

const identifier = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === sanitizeFlagText(value));
const flagKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .pipe(identifier(80));
const environmentKey = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .pipe(identifier(64));
const displayText = (max: number, min = 1) =>
  z.preprocess(
    (value) => (typeof value === "string" ? sanitizeFlagText(value) : value),
    z.string().min(min).max(max),
  );

const scalar = z.union([
  z
    .string()
    .max(500)
    .refine((value) => value.replace(emoji, "") === value && value.replace(controls, "") === value),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const localConditionSchema = conditionSchema
  .extend({
    attribute: identifier(64),
    // Targeting strings are exact values: whitespace and case are never normalized.
    values: z.array(scalar).min(1).max(50),
  })
  .strict()
  .superRefine((condition, ctx) => {
    const { operator, values } = condition;
    if (operator !== "in" && operator !== "not_in" && values.length !== 1) {
      ctx.addIssue({ code: "custom", message: "This operator needs one value." });
    }
    if (
      (operator === "greater_than" || operator === "less_than") &&
      typeof values[0] !== "number"
    ) {
      ctx.addIssue({ code: "custom", message: "Numeric comparisons need a number." });
    }
    if ((operator === "contains" || operator === "starts_with") && typeof values[0] !== "string") {
      ctx.addIssue({ code: "custom", message: "Text comparisons need a string." });
    }
  });

const localRuleSchema = ruleSchema
  .extend({
    id: z
      .string()
      .regex(/^rule_[a-z0-9_-]+$/)
      .pipe(identifier(80)),
    description: displayText(240),
    conditions: z.array(localConditionSchema).min(1).max(20),
    serve: serveSchema.strict(),
  })
  .strict();

/** Tighten locally: shared contracts remain the interoperability boundary. */
export const localFlagCreationOutputSchema = flagCreationOutputSchema
  .extend({
    key: flagKey,
    name: displayText(120),
    description: displayText(500, 0),
    environments: z
      .array(
        z
          .object({
            environmentKey,
            enabled: z.boolean(),
            rules: ruleSetSchema
              .extend({
                rules: z.array(localRuleSchema).max(20),
                defaultServe: serveSchema.strict(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    assumptions: z.array(displayText(500)).max(20),
    warnings: z.array(displayText(500)).max(20),
  })
  .strict();

const contextSchema = z
  .object({
    existingFlagKeys: z.array(flagKey).max(5000),
    knownUserAttributes: z.array(identifier(64)).max(200),
    environments: z
      .array(z.object({ key: environmentKey, name: identifier(120) }).strict())
      .min(1)
      .max(20),
    allowProduction: z.boolean(),
  })
  .strict();

export function validateFlagCreationContext(input: unknown): FlagCreationContext {
  const parsed = contextSchema.safeParse(input);
  if (!parsed.success) throw new FlagCreationError("INVALID_CONTEXT");
  const context = parsed.data;
  const labels = new Map<string, number>();
  for (const [index, environment] of context.environments.entries()) {
    for (const label of [environment.key, environment.name]) {
      const identity = label.normalize("NFKC").toLowerCase();
      if (labels.has(identity) && labels.get(identity) !== index) {
        throw new FlagCreationError("INVALID_CONTEXT");
      }
      labels.set(identity, index);
    }
  }
  if (
    new Set(context.existingFlagKeys).size !== context.existingFlagKeys.length ||
    new Set(context.knownUserAttributes).size !== context.knownUserAttributes.length ||
    JSON.stringify(context).length > 131072
  ) {
    throw new FlagCreationError("INVALID_CONTEXT");
  }
  return context;
}

function words(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Fail closed for common aliases and regional/numbered production environments.
const productionWord = /\b(?:production|prod|prd|live)\d*\b/;
export function isProductionEnvironment(environment: { key: string; name: string }): boolean {
  return (
    productionWord.test(words(environment.key)) || productionWord.test(words(environment.name))
  );
}

/** Conservative positive-command grammar, not an attempt to understand arbitrary English. */
export function explicitlyRequestsProduction(
  prompt: string,
  environment: { key: string; name: string },
): boolean {
  const normalized = prompt
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'");
  // Quoted content can describe a command without issuing it. Fail closed rather
  // than matching an embedded command across sentence/quotation boundaries.
  if (/["'`\u201C\u201D]/.test(normalized)) return false;
  // Negated, conditional, future, or hypothetical instructions cannot authorize production.
  if (
    /\b(?:no|not|never|don't|doesn't|cannot|can't|won't|without|except|exclude|avoid|disable|disabled|deactivate|deactivated|off|keep|leave|instead|untouched|but|if|unless|until|when|later|eventually|after|before|first|future|maybe|perhaps|consider|example|hypothetical)\b/.test(
      normalized,
    )
  )
    return false;
  const labels = [environment.key.toLowerCase(), environment.name.toLowerCase()];
  if (labels.some((label) => /^(?:production|prod|prd|live)$/.test(label)))
    labels.push("production", "prod", "prd", "live");
  const destinations = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const requestedDestination = new RegExp(
    `\\b(?:in|on|to|for)\\s+(?:the\\s+)?(?:${destinations})(?=$|[,.!?;]|\\s+(?:environment\\b|for\\b|with\\b|at\\b|and\\b|only\\b))`,
  );
  return normalized.split(/[.!?;\n]/).some((sentence) => {
    if (
      !/^\s*(?:please\s+)?(?:enable|activate|turn on|roll out|rollout|launch|release|deploy)\b/.test(
        sentence,
      )
    )
      return false;
    return requestedDestination.test(sentence.trim());
  });
}

export function validateFlagDraft(
  input: unknown,
  context: FlagCreationContext,
  prompt: string,
): FlagCreationOutput {
  const parsed = localFlagCreationOutputSchema.safeParse(input);
  if (!parsed.success) throw new FlagCreationError("INVALID_OUTPUT");
  const draft = parsed.data;
  if (context.existingFlagKeys.includes(draft.key))
    throw new FlagCreationError("DUPLICATE_FLAG_KEY");
  const environments = new Map(
    context.environments.map((environment) => [environment.key, environment]),
  );
  const knownAttributes = new Set(context.knownUserAttributes);
  const usedEnvironments = new Set<string>();
  const ruleIds = new Set<string>();
  for (const config of draft.environments) {
    const environment = environments.get(config.environmentKey);
    if (!environment) throw new FlagCreationError("UNKNOWN_ENVIRONMENT");
    if (usedEnvironments.has(config.environmentKey)) throw new FlagCreationError("INVALID_OUTPUT");
    usedEnvironments.add(config.environmentKey);
    if (
      config.enabled &&
      isProductionEnvironment(environment) &&
      (!context.allowProduction || !explicitlyRequestsProduction(prompt, environment))
    ) {
      throw new FlagCreationError("PRODUCTION_NOT_ALLOWED");
    }
    for (const rule of config.rules.rules) {
      if (ruleIds.has(rule.id)) throw new FlagCreationError("DUPLICATE_RULE_ID");
      ruleIds.add(rule.id);
      if (rule.conditions.some((condition) => !knownAttributes.has(condition.attribute))) {
        throw new FlagCreationError("UNKNOWN_ATTRIBUTE");
      }
    }
  }
  return flagCreationOutputSchema.parse(draft);
}
