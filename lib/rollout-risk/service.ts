import { createHash } from "node:crypto";
import { deterministicRisk, enforceRiskFloor } from "./checks";
import { generateRiskWithGemini, type RiskGeneration } from "./gemini";
import { rolloutRiskInputSchema, type RolloutRiskAssessment, type RolloutRiskInput } from "./types";
import { rolloutRiskPromptV1 } from "../../prompts/rollout-risk.v1";

export class RolloutRiskError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type RiskScope = { workspaceId: string; actorId: string; changeId: string };
export type RiskRun = {
  result: RolloutRiskAssessment;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Bounded, process-local cache/limits. Replace with the Phase 4 shared store for multiple replicas. */
export function createRiskService(
  options: {
    env?: Partial<NodeJS.ProcessEnv>;
    now?: () => number;
    generate?: typeof generateRiskWithGemini;
    record?: (scope: RiskScope, run: RiskRun) => Promise<void>;
  } = {},
) {
  const cache = new Map<string, RolloutRiskAssessment>();
  const pending = new Map<string, Promise<RolloutRiskAssessment>>();
  const limits = new Map<string, { count: number; until: number }>();
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;

  function consume(scope: RiskScope, live: boolean, time: number) {
    for (const [key, item] of limits) if (item.until <= time) limits.delete(key);
    const userKey = `user:${scope.actorId}`;
    const dayKey = `workspace:${scope.workspaceId}`;
    const user = limits.get(userKey) ?? { count: 0, until: time + 60_000 };
    const day = limits.get(dayKey) ?? { count: 0, until: time - (time % 86_400_000) + 86_400_000 };
    const configured = Number(env.AI_WORKSPACE_DAILY_BUDGET ?? 200);
    const budget = Number.isSafeInteger(configured) && configured >= 0 ? configured : 0;
    if (user.count >= 20 || (live && day.count >= budget) || limits.size >= 10_000) {
      throw new RolloutRiskError(
        429,
        "AI_LIMIT_REACHED",
        "The assessment limit has been reached. Try again later.",
      );
    }
    limits.set(userKey, { ...user, count: user.count + 1 });
    if (live) limits.set(dayKey, { ...day, count: day.count + 1 });
  }

  async function assess(raw: RolloutRiskInput, scope: RiskScope): Promise<RolloutRiskAssessment> {
    const input = rolloutRiskInputSchema.parse(raw);
    if (input.actorId !== scope.actorId)
      throw new RolloutRiskError(
        403,
        "INVALID_ACTOR",
        "The assessment actor does not match the session.",
      );
    const time = now();
    const mock = env.AI_MOCK === "true";
    const model = env.LLM_MODEL_REASONING ?? "gemini-2.5-pro";
    const key = createHash("sha256")
      .update(
        canonical({
          scope,
          input,
          mock,
          model,
          provider: env.AI_PROVIDER,
          version: rolloutRiskPromptV1.version,
        }),
      )
      .digest("hex");
    for (const [id, item] of cache) if (Date.parse(item.expiresAt) <= time) cache.delete(id);
    const hit = cache.get(key);
    if (hit) return structuredClone({ ...hit, cached: true });
    const active = pending.get(key);
    if (active) return structuredClone({ ...(await active), cached: true });
    if (pending.size >= 100)
      throw new RolloutRiskError(429, "AI_BUSY", "Assessments are busy. Try again shortly.");
    consume(scope, !mock, time);

    const operation = (async () => {
      const facts = deterministicRisk(input, time);
      let source: RolloutRiskAssessment["source"] = mock ? "mock" : "fallback";
      let generation: RiskGeneration | undefined;
      if (!mock && (env.AI_PROVIDER ?? "google") === "google") {
        try {
          generation = await (options.generate ?? generateRiskWithGemini)(input, facts, {
            model,
            apiKey: env.GEMINI_API_KEY ?? "",
          });
          source = "gemini";
        } catch {
          /* A model failure must never remove the deterministic safety gate. */
        }
      }
      const assessedAt = now();
      const result: RolloutRiskAssessment = {
        assessment: generation ? enforceRiskFloor(input, generation.output, time) : facts,
        source,
        model: source === "gemini" ? model : `${source}:${rolloutRiskPromptV1.version}`,
        notice:
          source === "fallback"
            ? "Gemini was unavailable or misconfigured. Deterministic checks and a conservative plan are shown instead."
            : null,
        assessedAt: new Date(assessedAt).toISOString(),
        expiresAt: new Date(assessedAt + 60_000).toISOString(),
        cached: false,
      };
      await options.record?.(scope, {
        result,
        latencyMs: Math.max(0, assessedAt - time),
        tokensIn: generation?.tokensIn ?? 0,
        tokensOut: generation?.tokensOut ?? 0,
      });
      if (cache.size >= 500) cache.delete(cache.keys().next().value!);
      cache.set(key, structuredClone(result));
      return result;
    })();
    pending.set(key, operation);
    try {
      return structuredClone(await operation);
    } finally {
      pending.delete(key);
    }
  }

  return { assess };
}
