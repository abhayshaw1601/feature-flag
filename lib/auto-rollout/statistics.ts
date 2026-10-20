import {
  guardrailSchema,
  type Guardrail,
  type GuardrailInput,
  type GuardrailResult,
  type MetricName,
  type MetricObservation,
} from "./types";

const Z_95 = 1.959963984540054;
const MONITOR_INTERVAL_MS = 30_000;
const MAX_OBSERVATIONS = 200_000;
const MAX_SAMPLES_PER_VARIATION = 50_000;

type SampleSummary = { count: number; successes: number; latest: number };
type Evidence = {
  unique: Map<string, MetricObservation | null>;
  issues: Map<MetricName, string>;
  globalIssue?: string;
};

function emptyResult(metric: MetricName, reason: string): GuardrailResult {
  return {
    metric,
    status: "INCONCLUSIVE",
    baseline: null,
    enabled: null,
    baselineSamples: 0,
    enabledSamples: 0,
    delta: null,
    zScore: null,
    reason,
  };
}

function isMetric(metric: unknown): metric is MetricName {
  return metric === "error_rate" || metric === "conversion" || metric === "latency_ms";
}

function sameObservation(a: MetricObservation, b: MetricObservation): boolean {
  return (
    a.metric === b.metric &&
    a.variation === b.variation &&
    Object.is(a.value, b.value) &&
    a.occurredAt === b.occurredAt
  );
}

function collectEvidence(input: GuardrailInput): Evidence {
  const evidence: Evidence = { unique: new Map(), issues: new Map() };
  for (const observation of input.observations) {
    if (
      !observation ||
      typeof observation.flagKey !== "string" ||
      typeof observation.environmentId !== "string"
    ) {
      evidence.globalIssue = "Malformed observation scope; telemetry cannot be trusted.";
      break;
    }
    if (
      observation.flagKey !== input.scope.flagKey ||
      observation.environmentId !== input.scope.environmentId
    ) {
      continue;
    }
    if (!Number.isSafeInteger(observation.stepVersion) || observation.stepVersion < 0) {
      evidence.globalIssue = "Invalid observation step version.";
      break;
    }
    if (observation.stepVersion !== input.stepVersion) continue;
    if (!isMetric(observation.metric)) {
      evidence.globalIssue = "Unknown metric in current-step telemetry.";
      break;
    }
    if (!Number.isFinite(observation.occurredAt) || observation.occurredAt < 0) {
      evidence.issues.set(observation.metric, "Invalid observation timestamp.");
      continue;
    }
    // A matching version alone is insufficient: pre-step observations are not evidence.
    if (observation.occurredAt < input.stepStartedAt) continue;
    if (typeof observation.id !== "string" || observation.id.length === 0) {
      evidence.issues.set(observation.metric, "Missing observation id; cannot deduplicate.");
      continue;
    }
    const previous = evidence.unique.get(observation.id);
    if (previous === undefined) {
      evidence.unique.set(observation.id, observation);
    } else if (previous === null || !sameObservation(previous, observation)) {
      const reason = "Conflicting duplicate observation id; telemetry cannot be trusted.";
      evidence.issues.set(observation.metric, reason);
      if (previous) evidence.issues.set(previous.metric, reason);
      // Never choose a winner by arrival order or let another copy revive this id.
      evidence.unique.set(observation.id, null);
    }
  }
  return evidence;
}

function wilsonInterval(successes: number, count: number): [number, number] {
  const rate = successes / count;
  const zSquared = Z_95 * Z_95;
  const denominator = 1 + zSquared / count;
  const center = (rate + zSquared / (2 * count)) / denominator;
  const radius =
    (Z_95 * Math.sqrt((rate * (1 - rate)) / count + zSquared / (4 * count * count))) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

// Tolerate arithmetic roundoff at an inclusive threshold, not a material near miss.
function reaches(value: number, threshold: number): boolean {
  return (
    value >= threshold ||
    Math.abs(value - threshold) <=
      8 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(threshold))
  );
}

/** Retain only the largest n-ceil(.95*n)+1 values in a min heap; its root is p95. */
class UpperTail {
  private readonly heap: number[] = [];
  private readonly capacity: number;

  constructor(count: number) {
    this.capacity = count - Math.ceil(0.95 * count) + 1;
  }

  add(value: number): void {
    const heap = this.heap;
    if (heap.length < this.capacity) {
      heap.push(value);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent] <= heap[index]) break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
    } else if (value > heap[0]) {
      heap[0] = value;
      let index = 0;
      while (2 * index + 1 < heap.length) {
        let child = 2 * index + 1;
        if (child + 1 < heap.length && heap[child + 1] < heap[child]) child++;
        if (heap[index] <= heap[child]) break;
        [heap[index], heap[child]] = [heap[child], heap[index]];
        index = child;
      }
    }
  }

  value(): number | null {
    return this.heap[0] ?? null;
  }
}

function evaluateMetric(
  guard: Guardrail,
  input: GuardrailInput,
  evidence: Evidence,
): GuardrailResult {
  const result = emptyResult(guard.metric, "");
  const windowMs = guard.windowSeconds * 1_000;
  const from = Math.max(input.stepStartedAt, input.now - windowMs);
  const baseline: SampleSummary = { count: 0, successes: 0, latest: -Infinity };
  const enabled: SampleSummary = { count: 0, successes: 0, latest: -Infinity };
  let issue = evidence.issues.get(guard.metric);

  for (const observation of evidence.unique.values()) {
    if (!observation || observation.metric !== guard.metric) continue;
    if (observation.occurredAt > input.now) {
      issue = "Future observation timestamp; current telemetry cannot be trusted.";
      continue;
    }
    if (observation.occurredAt < from) continue;
    if (
      (observation.variation !== "baseline" && observation.variation !== "enabled") ||
      !Number.isFinite(observation.value) ||
      (guard.metric === "latency_ms"
        ? observation.value < 0
        : observation.value !== 0 && observation.value !== 1)
    ) {
      issue = "Invalid observation value or variation in the active window.";
      continue;
    }
    const summary = observation.variation === "baseline" ? baseline : enabled;
    summary.count++;
    if (guard.metric !== "latency_ms") summary.successes += observation.value;
    summary.latest = Math.max(summary.latest, observation.occurredAt);
  }
  result.baselineSamples = baseline.count;
  result.enabledSamples = enabled.count;
  if (baseline.count > MAX_SAMPLES_PER_VARIATION || enabled.count > MAX_SAMPLES_PER_VARIATION) {
    issue = `Sample limit exceeded (${MAX_SAMPLES_PER_VARIATION} per variation); no truncated decision.`;
  }
  if (issue) return { ...result, reason: issue };

  if (guard.metric === "latency_ms") {
    const baselineTail = new UpperTail(baseline.count);
    const enabledTail = new UpperTail(enabled.count);
    for (const observation of evidence.unique.values()) {
      if (!observation || observation.metric !== guard.metric || observation.occurredAt < from) {
        continue;
      }
      // All current-window observations were validated above, including future timestamps.
      (observation.variation === "baseline" ? baselineTail : enabledTail).add(observation.value);
    }
    result.baseline = baselineTail.value();
    result.enabled = enabledTail.value();
    if (result.baseline !== null && result.baseline > 0 && result.enabled !== null) {
      const delta = (result.enabled - result.baseline) / result.baseline;
      if (Number.isFinite(delta)) result.delta = delta;
    }
  } else {
    result.baseline = baseline.count ? baseline.successes / baseline.count : null;
    result.enabled = enabled.count ? enabled.successes / enabled.count : null;
    if (result.baseline !== null && result.enabled !== null) {
      result.delta =
        guard.metric === "error_rate"
          ? result.enabled - result.baseline
          : result.baseline - result.enabled;
      const pooled = (baseline.successes + enabled.successes) / (baseline.count + enabled.count);
      const standardError = Math.sqrt(
        pooled * (1 - pooled) * (1 / baseline.count + 1 / enabled.count),
      );
      result.zScore = standardError > 0 ? result.delta / standardError : 0;
    }
  }

  // No healthy/breach classification, including obviously bad traffic, before a full window.
  if (input.now - input.stepStartedAt < windowMs) {
    return {
      ...result,
      status: "INSUFFICIENT",
      reason: `Full ${guard.windowSeconds}s window has not elapsed for this step.`,
    };
  }
  if (baseline.count < guard.minSamples || enabled.count < guard.minSamples) {
    return {
      ...result,
      status: "INSUFFICIENT",
      reason: `Need at least ${guard.minSamples} unique samples in each variation.`,
    };
  }
  if (
    baseline.latest <= input.now - MONITOR_INTERVAL_MS ||
    enabled.latest <= input.now - MONITOR_INTERVAL_MS
  ) {
    return {
      ...result,
      status: "INSUFFICIENT",
      reason: "Stale telemetry: both variations need a sample newer than now - 30s.",
    };
  }
  if (result.delta === null) {
    return {
      ...result,
      reason:
        "Relative p95 increase is undefined for a zero baseline or exceeds finite numeric range.",
    };
  }

  if (guard.metric === "latency_ms") {
    const breached = reaches(result.delta, guard.threshold);
    return {
      ...result,
      status: breached ? "BREACHED" : "HEALTHY",
      reason: breached
        ? "Nearest-rank p95 relative increase meets or exceeds the inclusive threshold."
        : "Nearest-rank p95 relative increase is below the threshold.",
    };
  }

  const harmful = guard.metric === "error_rate" ? enabled : baseline;
  const reference = guard.metric === "error_rate" ? baseline : enabled;
  const [, harmfulUpper] = wilsonInterval(harmful.successes, harmful.count);
  const [referenceLower] = wilsonInterval(reference.successes, reference.count);
  // Newcombe's Wilson-score difference interval (method 10), upper endpoint.
  // Unlike a Wald interval it retains uncertainty at 0/n and n/n.
  const upperHarm = Math.min(
    1,
    result.delta +
      Math.hypot(
        harmfulUpper - harmful.successes / harmful.count,
        reference.successes / reference.count - referenceLower,
      ),
  );
  const pooled = (baseline.successes + enabled.successes) / (baseline.count + enabled.count);
  const adequateExpectedCounts = [baseline.count, enabled.count].every(
    (count) => reaches(count * pooled, 5) && reaches(count * (1 - pooled), 5),
  );
  if (
    reaches(result.delta, guard.threshold) &&
    result.zScore !== null &&
    result.zScore >= Z_95 &&
    adequateExpectedCounts
  ) {
    return {
      ...result,
      status: "BREACHED",
      reason:
        "Inclusive absolute threshold met with deterioration significant at 95% (pooled z-test).",
    };
  }
  if (!reaches(upperHarm, guard.threshold)) {
    return {
      ...result,
      status: "HEALTHY",
      reason: "95% Wilson/Newcombe upper harm bound is below the absolute threshold.",
    };
  }
  return {
    ...result,
    reason: adequateExpectedCounts
      ? "95% uncertainty interval cannot rule out threshold-sized harm; no significant threshold breach."
      : "Sparse expected counts: pooled z-test is unreliable and the 95% interval cannot rule out threshold-sized harm.",
  };
}

/**
 * Pure, fixed-look guardrail evaluation. Timestamps are milliseconds. The evidence
 * window is [max(stepStartedAt, now - windowSeconds*1000), now], inclusive at both
 * ends. Exact scope/version matching precedes deduplication; pre-step rows are
 * ignored. Conflicts anywhere in that scoped step invalidate the affected metrics.
 * Future/invalid active rows fail closed, rather than silently improve a rate.
 * Each variation needs a sample in (now - 30_000, now]; replaying a previous tick
 * cannot satisfy freshness. A full window must elapse even for a breach. HOLD
 * duration and sample-timeout policy belong to the caller, not this evaluator.
 *
 * Rates use directional deterioration, a two-sided 95% pooled z-test (positive
 * z >= 1.96), and a Wilson/Newcombe 95% upper harm bound for health. Sparse expected
 * cells (<5) cannot justify a z-test breach. Score intervals are approximate, not
 * exact coverage guarantees; independence/randomized allocation are assumed.
 * Repeated monitoring and multiple metrics have no sequential/multiplicity correction.
 * Latency uses empirical nearest-rank p95, not a significance test; zero baseline
 * is inconclusive. Thresholds are inclusive; rate breaches also need significance.
 *
 * At most 200,000 input rows and 50,000 samples/variation/metric are accepted.
 * Overflows fail closed, never truncate. Deduplication is O(rows) memory; p95 uses
 * O(.05*n) heap memory and O(n log(.05*n)) work, without sorting/copying all samples.
 */
export function evaluateGuardrails(input: GuardrailInput): GuardrailResult[] {
  let issue: string | undefined;
  if (
    !input.scope ||
    typeof input.scope.flagKey !== "string" ||
    input.scope.flagKey.length === 0 ||
    typeof input.scope.environmentId !== "string" ||
    input.scope.environmentId.length === 0 ||
    !Number.isSafeInteger(input.stepVersion) ||
    input.stepVersion < 0 ||
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.stepStartedAt) ||
    input.stepStartedAt < 0 ||
    input.now < input.stepStartedAt ||
    !Array.isArray(input.observations)
  ) {
    issue = "Invalid evaluation scope, step, time, or observations.";
  } else if (input.observations.length > MAX_OBSERVATIONS) {
    issue = `Observation limit exceeded (${MAX_OBSERVATIONS}); no truncated decision.`;
  } else if (
    input.guardrails.length > 3 ||
    new Set(input.guardrails.map((guard) => guard.metric)).size !== input.guardrails.length
  ) {
    issue = "Use at most one guardrail per metric (three metrics maximum).";
  }
  if (issue) return input.guardrails.map((guard) => emptyResult(guard.metric, issue));
  const evidence = collectEvidence(input);
  return input.guardrails.map((guard) => {
    if (!guardrailSchema.safeParse(guard).success) {
      return emptyResult(guard.metric, "Invalid guardrail configuration.");
    }
    if (evidence.globalIssue) return emptyResult(guard.metric, evidence.globalIssue);
    return evaluateMetric(guard, input, evidence);
  });
}
