import {
  defaultRampPolicy,
  rampPolicySchema,
  type MetricName,
  type RampPolicy,
} from "@/lib/auto-rollout/types";

export const metricLabels: Record<MetricName, string> = {
  error_rate: "Error rate",
  latency_ms: "p95 latency",
  conversion: "Conversion",
};

export type PolicyDraft = {
  steps: string;
  holdSeconds: string;
  errorThreshold: string;
};

export type PolicyErrors = Partial<Record<keyof PolicyDraft | "policy", string>>;

export function createPolicyDraft(): PolicyDraft {
  return {
    steps: defaultRampPolicy.steps.join(", "),
    holdSeconds: String(defaultRampPolicy.holdSeconds),
    errorThreshold: String(
      (defaultRampPolicy.guardrails.find((guard) => guard.metric === "error_rate")?.threshold ??
        0.02) * 100,
    ),
  };
}

export function validatePolicyDraft(draft: PolicyDraft): {
  policy: RampPolicy | null;
  errors: PolicyErrors;
} {
  const errors: PolicyErrors = {};
  const parts = draft.steps.split(",").map((part) => part.trim());
  const steps = parts.map(Number);
  if (
    parts.length < 2 ||
    parts.length > 10 ||
    parts.some((part) => !/^\d+$/.test(part)) ||
    steps.some((step) => step < 1 || step > 100) ||
    steps.some((step, index) => index > 0 && step <= steps[index - 1]) ||
    steps.at(-1) !== 100
  ) {
    errors.steps =
      "Enter 2–10 comma-separated whole percentages, strictly increasing from 1–100 and ending at 100.";
  }
  const holdSeconds = Number(draft.holdSeconds);
  if (!/^\d+$/.test(draft.holdSeconds.trim()) || holdSeconds < 30 || holdSeconds > 86_400) {
    errors.holdSeconds = "Enter a whole hold duration from 30 to 86,400 seconds.";
  }
  const errorThreshold = Number(draft.errorThreshold);
  if (
    !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(draft.errorThreshold.trim()) ||
    !Number.isFinite(errorThreshold) ||
    errorThreshold <= 0 ||
    errorThreshold > 100
  ) {
    errors.errorThreshold =
      "Enter an error-rate increase greater than 0 and at most 100 percentage points.";
  }
  if (Object.keys(errors).length > 0) return { policy: null, errors };

  const parsed = rampPolicySchema.safeParse({
    ...defaultRampPolicy,
    steps,
    holdSeconds,
    guardrails: defaultRampPolicy.guardrails.map((guard) =>
      guard.metric === "error_rate" ? { ...guard, threshold: errorThreshold / 100 } : { ...guard },
    ),
  });
  if (!parsed.success) {
    return {
      policy: null,
      errors: { policy: parsed.error.issues.map((issue) => issue.message).join(" ") },
    };
  }
  return { policy: parsed.data, errors };
}

export function formatMetric(metric: MetricName, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return metric === "latency_ms" ? `${value.toFixed(1)} ms` : `${(value * 100).toFixed(2)}%`;
}

export function formatDelta(metric: MetricName, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Number((value * 100).toFixed(2));
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)} ${metric === "latency_ms" ? "%" : "pp"}`;
}

export function formatVirtualTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `T+${hours}h ${minutes}m ${remainder}s`
    : `T+${Math.floor(seconds / 60)}m ${remainder}s`;
}
