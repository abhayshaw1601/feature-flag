import { z } from "zod";

export const metricNameSchema = z.enum(["error_rate", "latency_ms", "conversion"]);
export type MetricName = z.infer<typeof metricNameSchema>;
export const guardrailSchema = z
  .object({
    metric: metricNameSchema,
    // Rates use an absolute fractional difference (0.02 = 2 percentage points).
    // Latency uses relative p95 increase (0.20 = 20%).
    threshold: z.number().finite().positive().max(1),
    windowSeconds: z.number().int().min(30).max(3600),
    minSamples: z.number().int().min(20).max(10_000),
  })
  .strict();
export type Guardrail = z.infer<typeof guardrailSchema>;

export const rampPolicySchema = z
  .object({
    steps: z.array(z.number().int().min(1).max(100)).min(2).max(10),
    holdSeconds: z.number().int().min(30).max(86_400),
    monitorIntervalSeconds: z.literal(30),
    guardrails: z.array(guardrailSchema).min(1).max(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.steps.at(-1) !== 100 ||
      value.steps.some((step, index) => index > 0 && step <= value.steps[index - 1])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Steps must strictly increase and end at 100%.",
      });
    }
    if (new Set(value.guardrails.map((guard) => guard.metric)).size !== value.guardrails.length) {
      ctx.addIssue({
        code: "custom",
        path: ["guardrails"],
        message: "Use one guardrail per metric.",
      });
    }
  });
export type RampPolicy = z.infer<typeof rampPolicySchema>;

export type RolloutScope = { flagKey: string; environmentId: string };
export type MetricObservation = RolloutScope & {
  id: string;
  variation: "baseline" | "enabled";
  metric: MetricName;
  value: number;
  occurredAt: number;
  stepVersion: number;
};
export type GuardrailResult = {
  metric: MetricName;
  status: "HEALTHY" | "BREACHED" | "INSUFFICIENT" | "INCONCLUSIVE";
  baseline: number | null;
  enabled: number | null;
  baselineSamples: number;
  enabledSamples: number;
  /** Positive means deterioration: rate points for rates, relative increase for latency. */
  delta: number | null;
  zScore: number | null;
  reason: string;
};
export type GuardrailInput = {
  observations: readonly MetricObservation[];
  guardrails: readonly Guardrail[];
  scope: RolloutScope;
  stepVersion: number;
  stepStartedAt: number;
  now: number;
};
export type RolloutDecision = {
  decision: "HOLD" | "ROLLBACK" | "ADVANCE";
  reasons: string[];
  breachedMetrics: MetricName[];
  checks: GuardrailResult[];
  /** Final step finished its healthy hold; do not write a redundant 100% change. */
  complete: boolean;
};
export type RolloutAudit = {
  id: string;
  createdAt: number;
  actor: "FlagForge Guard" | "Demo operator";
  action:
    | "START"
    | "AUTO_RAMP"
    | "AUTO_ROLLBACK"
    | "PAUSE"
    | "RESUME"
    | "MANUAL_ADVANCE"
    | "MANUAL_ROLLBACK"
    | "COMPLETE"
    | "OPT_OUT";
  before: { enabled: boolean; rolloutPercent: number };
  after: { enabled: boolean; rolloutPercent: number };
  summary: string;
};
export type MonitorRecord = RolloutDecision & {
  at: number;
  stepVersion: number;
  rolloutPercent: number;
};
export type RolloutState = RolloutScope & {
  policy: RampPolicy;
  optedIn: boolean;
  status: "idle" | "running" | "paused" | "rolled_back" | "completed";
  enabled: boolean;
  rolloutPercent: number;
  stepIndex: number;
  stepVersion: number;
  stepStartedAt: number | null;
  lastEvaluatedAt: number | null;
  nextCheckAt: number | null;
  /** Virtual milliseconds since the demo began, not wall-clock time. */
  now: number;
  observations: MetricObservation[];
  history: MonitorRecord[];
  audit: RolloutAudit[];
  notifications: Array<{ id: string; at: number; message: string }>;
};

export const defaultRampPolicy: RampPolicy = {
  steps: [5, 25, 50, 100],
  holdSeconds: 60,
  monitorIntervalSeconds: 30,
  guardrails: [
    { metric: "error_rate", threshold: 0.02, windowSeconds: 60, minSamples: 100 },
    { metric: "latency_ms", threshold: 0.2, windowSeconds: 60, minSamples: 100 },
    { metric: "conversion", threshold: 0.05, windowSeconds: 60, minSamples: 100 },
  ],
};
