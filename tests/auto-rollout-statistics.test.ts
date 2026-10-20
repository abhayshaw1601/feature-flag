import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGuardrails } from "../lib/auto-rollout/statistics";
import {
  defaultRampPolicy,
  type Guardrail,
  type GuardrailInput,
  type MetricName,
  type MetricObservation,
} from "../lib/auto-rollout/types";

const scope = { flagKey: "checkout_refresh", environmentId: "demo" };
const stepVersion = 3;
const now = 60_000;

function samples(
  metric: MetricName,
  variation: MetricObservation["variation"],
  count: number,
  value: number | ((index: number) => number),
  occurredAt = now,
  prefix = `${metric}-${variation}-${occurredAt}`,
): MetricObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    ...scope,
    stepVersion,
    id: `${prefix}-${index}`,
    metric,
    variation,
    value: typeof value === "function" ? value(index) : value,
    occurredAt,
  }));
}

function rates(
  metric: "error_rate" | "conversion",
  baselineCount: number,
  baselineSuccesses: number,
  enabledCount: number,
  enabledSuccesses: number,
): MetricObservation[] {
  return [
    ...samples(metric, "baseline", baselineCount, (index) => Number(index < baselineSuccesses)),
    ...samples(metric, "enabled", enabledCount, (index) => Number(index < enabledSuccesses)),
  ];
}

function input(
  observations: readonly MetricObservation[],
  overrides: Partial<GuardrailInput> = {},
): GuardrailInput {
  return {
    observations,
    guardrails: defaultRampPolicy.guardrails,
    scope,
    stepVersion,
    now,
    stepStartedAt: 0,
    ...overrides,
  };
}

function check(
  observations: readonly MetricObservation[],
  guard: Partial<Guardrail> = {},
  overrides: Partial<GuardrailInput> = {},
) {
  const metric = guard.metric ?? "error_rate";
  return evaluateGuardrails(
    input(observations, {
      ...overrides,
      guardrails: [{ metric, threshold: 0.02, windowSeconds: 60, minSamples: 20, ...guard }],
    }),
  )[0];
}

function demo(cycles = 2, injected = false): MetricObservation[] {
  return Array.from({ length: cycles }, (_, cycle) => {
    const at = (cycle + 1) * 30_000;
    return [
      ...samples("error_rate", "baseline", 200, (index) => Number(index < 2), at),
      ...samples("error_rate", "enabled", 200, (index) => Number(index < (injected ? 40 : 2)), at),
      ...samples("conversion", "baseline", 200, (index) => Number(index < 40), at),
      ...samples("conversion", "enabled", 200, (index) => Number(index < 44), at),
      ...samples("latency_ms", "baseline", 200, (index) => (index < 180 ? 100 : 120), at),
      ...samples(
        "latency_ms",
        "enabled",
        200,
        (index) => (index < 180 ? 105 : injected ? 300 : 125),
        at,
      ),
    ];
  }).flat();
}

function close(actual: number | null, expected: number, tolerance = 1e-12) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} != ${expected}`);
}

test("healthy default fixture passes all guardrails after two 30s cycles", () => {
  const results = evaluateGuardrails(input(demo()));
  assert.deepEqual(
    results.map((result) => result.metric),
    ["error_rate", "latency_ms", "conversion"],
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["HEALTHY", "HEALTHY", "HEALTHY"],
  );
  for (const result of results) {
    assert.equal(result.baselineSamples, 400);
    assert.equal(result.enabledSamples, 400);
    assert.ok(result.reason.length > 0);
  }
  close(results[0].baseline, 0.01);
  close(results[0].enabled, 0.01);
  close(results[0].delta, 0);
  close(results[0].zScore, 0);
  assert.equal(results[1].baseline, 120);
  assert.equal(results[1].enabled, 125);
  close(results[1].delta, 5 / 120);
  assert.equal(results[1].zScore, null);
  close(results[2].baseline, 0.2);
  close(results[2].enabled, 0.22);
  close(results[2].delta, -0.02);
});

test("injected fixture breaches error and latency within two cycles", () => {
  const results = evaluateGuardrails(input(demo(2, true)));
  assert.deepEqual(
    results.map((result) => result.status),
    ["BREACHED", "BREACHED", "HEALTHY"],
  );
  close(results[0].delta, 0.19);
  assert.ok(results[0].zScore! > 8);
  assert.equal(results[1].enabled, 300);
  close(results[1].delta, 1.5);
});

for (const injected of [false, true]) {
  test(`full window gates ${injected ? "breached" : "healthy"} evidence at the first cycle`, () => {
    const observations = demo(1, injected);
    for (const at of [30_000, 59_999]) {
      const results = evaluateGuardrails(input(observations, { now: at }));
      assert.ok(results.every((result) => result.status === "INSUFFICIENT"));
      assert.ok(results.every((result) => /full.*window/i.test(result.reason)));
      assert.ok(results.every((result) => result.baselineSamples === 200));
    }
  });
}

test("each configured window must elapse independently, including on later steps", () => {
  const observations = demo().map((row) => ({ ...row, occurredAt: row.occurredAt + 10_000 }));
  const results = evaluateGuardrails(
    input(observations, {
      now: 70_000,
      stepStartedAt: 10_000,
      guardrails: defaultRampPolicy.guardrails.map((guard) => ({
        ...guard,
        windowSeconds: guard.metric === "conversion" ? 90 : 60,
      })),
    }),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["HEALTHY", "HEALTHY", "INSUFFICIENT"],
  );
});

test("pooled two-proportion z-score uses observed sample sizes and rate direction", () => {
  const result = check(rates("error_rate", 100, 10, 200, 40));
  close(result.baseline, 0.1);
  close(result.enabled, 0.2);
  close(result.delta, 0.1);
  // Pooled p = 50/300 = 1/6; SE = sqrt((1/6)*(5/6)*(1/100 + 1/200)).
  close(result.zScore, 2.1908902300206643);
  assert.equal(result.status, "BREACHED");
});

test("95% test uses a positive 1.96 cutoff, not a one-sided 1.645 or absolute z", () => {
  const marginal = check(rates("error_rate", 200, 20, 200, 32));
  close(marginal.zScore, 1.7841031003501577);
  assert.equal(marginal.status, "INCONCLUSIVE");
  const significant = check(rates("error_rate", 200, 20, 200, 34));
  assert.ok(significant.zScore! > 1.96);
  assert.equal(significant.status, "BREACHED");
  const improved = check(rates("error_rate", 200, 34, 200, 20));
  assert.ok(improved.zScore! < -1.96);
  assert.equal(improved.status, "HEALTHY");
});

test("conversion decline is harmful and conversion improvement is healthy", () => {
  const decline = check(rates("conversion", 400, 160, 400, 80), {
    metric: "conversion",
    threshold: 0.05,
  });
  close(decline.delta, 0.2);
  assert.ok(decline.zScore! > 1.96);
  assert.equal(decline.status, "BREACHED");
  const improvement = check(rates("conversion", 400, 80, 400, 160), {
    metric: "conversion",
    threshold: 0.05,
  });
  close(improvement.delta, -0.2);
  assert.ok(improvement.zScore! < -1.96);
  assert.equal(improvement.status, "HEALTHY");
});

test("rate threshold is absolute, inclusive, and resistant to subtraction roundoff", () => {
  const observations = rates("error_rate", 10_000, 1_000, 10_000, 1_200);
  const result = check(observations);
  close(result.delta, 0.02);
  assert.equal(result.status, "BREACHED");
  // A materially greater threshold must not round down to a breach.
  assert.equal(check(observations, { threshold: 0.02000001 }).status, "INCONCLUSIVE");
  assert.equal(check(observations, { threshold: 0.1 }).status, "HEALTHY");
  const conversion = check(rates("conversion", 10_000, 1_200, 10_000, 1_000), {
    metric: "conversion",
  });
  assert.equal(conversion.status, "BREACHED");
});

test("significant deterioration below the configured threshold is not a breach", () => {
  const result = check(rates("error_rate", 10_000, 1_000, 10_000, 1_100), { threshold: 0.05 });
  assert.ok(result.zScore! > 1.96);
  close(result.delta, 0.01);
  assert.equal(result.status, "HEALTHY");
});

test("non-significance alone is inconclusive when threshold-sized harm remains plausible", () => {
  const equal = check(rates("error_rate", 100, 10, 100, 10));
  assert.equal(equal.zScore, 0);
  assert.equal(equal.status, "INCONCLUSIVE");
  const harm = check(rates("error_rate", 20, 2, 20, 3));
  assert.ok(harm.delta! > 0.02);
  assert.ok(harm.zScore! < 1.96);
  assert.equal(harm.status, "INCONCLUSIVE");
});

test("sparse expected cells cannot establish a breach using a dubious z approximation", () => {
  const result = check(rates("error_rate", 400, 0, 400, 4), { threshold: 0.005 });
  assert.ok(result.zScore! > 1.96);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.match(result.reason, /sparse/i);
});

test("exactly five expected events or non-events satisfy the z-test adequacy boundary", () => {
  // Pooled p=.9 gives 50*(1-.9)=4.999999999999999 in floating-point arithmetic.
  const result = check(rates("error_rate", 50, 41, 50, 49));
  assert.equal(result.status, "BREACHED");
  close(result.zScore, 8 / 3);
  assert.equal(check(rates("error_rate", 50, 1, 50, 9)).status, "BREACHED");
});

test("health requires an uncertainty bound strictly below the threshold", () => {
  // For zero successes the Wilson upper endpoint is z^2/(n+z^2), not zero.
  const upperBound = 0.16112515805281938;
  const observations = rates("error_rate", 20, 0, 20, 0);
  assert.equal(check(observations, { threshold: upperBound }).status, "INCONCLUSIVE");
  assert.equal(check(observations, { threshold: upperBound + 0.000001 }).status, "HEALTHY");
});

for (const metric of ["error_rate", "conversion"] as const) {
  for (const value of [0, 1]) {
    test(`${metric} all-${value} observations retain uncertainty at small sample sizes`, () => {
      const small = check(rates(metric, 20, 20 * value, 20, 20 * value), { metric });
      assert.equal(small.status, "INCONCLUSIVE");
      assert.equal(small.zScore, 0);
      const large = check(rates(metric, 400, 400 * value, 400, 400 * value), { metric });
      assert.equal(large.status, "HEALTHY");
      assert.equal(
        check(rates(metric, 400, 400 * value, 400, 400 * value), { metric, threshold: 0.001 })
          .status,
        "INCONCLUSIVE",
      );
    });
  }
}

test("opposite Bernoulli extremes are significant with finite pooled variance", () => {
  for (const metric of ["error_rate", "conversion"] as const) {
    const result = check(
      rates(metric, 20, metric === "conversion" ? 20 : 0, 20, metric === "conversion" ? 0 : 20),
      { metric, threshold: 1 },
    );
    assert.equal(result.status, "BREACHED");
    assert.equal(result.delta, 1);
    close(result.zScore, Math.sqrt(40));
  }
});

test("minimum samples apply separately and inclusively to each variation", () => {
  for (const [baselineCount, enabledCount] of [
    [19, 200],
    [200, 19],
    [0, 200],
    [200, 0],
    [0, 0],
  ]) {
    const result = check(rates("error_rate", baselineCount, 0, enabledCount, 0));
    assert.equal(result.status, "INSUFFICIENT");
    assert.equal(result.baselineSamples, baselineCount);
    assert.equal(result.enabledSamples, enabledCount);
  }
  assert.equal(check(rates("error_rate", 20, 0, 20, 0), { threshold: 0.2 }).status, "HEALTHY");
});

test("waiting cannot turn missing or uncertain samples into healthy timeout evidence", () => {
  for (const at of [60_000, 600_000, 86_400_000]) {
    const missing = check([], {}, { now: at });
    assert.equal(missing.status, "INSUFFICIENT");
    const sparse = rates("error_rate", 20, 2, 20, 2).map((row) => ({ ...row, occurredAt: at }));
    assert.equal(check(sparse, {}, { now: at }).status, "INCONCLUSIVE");
  }
});

test("sliding window includes its exact lower boundary and now, excluding older rows", () => {
  const observations = [
    ...samples("error_rate", "baseline", 20, 0, 30_000),
    ...samples("error_rate", "enabled", 20, 0, 30_000),
    ...samples("error_rate", "baseline", 1, 0, 90_000),
    ...samples("error_rate", "enabled", 1, 0, 90_000),
    ...samples("error_rate", "baseline", 50, 1, 29_999),
    ...samples("error_rate", "enabled", 50, 1, 29_999),
  ];
  const result = check(observations, { threshold: 0.2 }, { now: 90_000 });
  assert.equal(result.status, "HEALTHY");
  assert.equal(result.baselineSamples, 21);
  assert.equal(result.enabledSamples, 21);
  assert.equal(result.baseline, 0);
});

test("step start is inclusive but even matching-version pre-step observations are excluded", () => {
  const observations = [
    ...samples("error_rate", "baseline", 20, 0, 10_000),
    ...samples("error_rate", "enabled", 20, 0, 10_000),
    ...samples("error_rate", "baseline", 1, 0, 70_000),
    ...samples("error_rate", "enabled", 1, 0, 70_000),
    ...samples("error_rate", "baseline", 100, 1, 9_999),
    ...samples("error_rate", "enabled", 100, 1, 9_999),
  ];
  const result = check(observations, { threshold: 0.2 }, { now: 70_000, stepStartedAt: 10_000 });
  assert.equal(result.status, "HEALTHY");
  assert.equal(result.baselineSamples, 21);
  assert.equal(result.enabledSamples, 21);
});

test("foreign flag/environment and previous/next versions never count or collide", () => {
  const observations = rates("error_rate", 400, 4, 400, 4);
  const foreign = [
    ...observations.map((row) => ({ ...row, flagKey: "other", value: NaN })),
    ...observations.map((row) => ({ ...row, environmentId: "production", value: NaN })),
    ...observations.map((row) => ({ ...row, stepVersion: stepVersion - 1, value: NaN })),
    ...observations.map((row) => ({ ...row, stepVersion: stepVersion + 1, value: NaN })),
  ];
  assert.deepEqual(check([...foreign, ...observations]), check(observations));
  assert.equal(check(foreign).status, "INSUFFICIENT");
});

test("identical duplicate ids do not inflate either sample counts or significance", () => {
  const observations = rates("error_rate", 19, 0, 19, 0);
  const result = check([
    ...observations,
    ...observations,
    ...observations.map((row) => ({ ...row })),
  ]);
  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.baselineSamples, 19);
  assert.equal(result.enabledSamples, 19);
  assert.deepEqual(result, check(observations));
});

for (const conflict of [
  { value: 0 },
  { variation: "enabled" as const },
  { occurredAt: 59_999 },
  { metric: "latency_ms" as const },
]) {
  test(`conflicting duplicate (${Object.keys(conflict)[0]}) fails closed in any order`, () => {
    const observations = demo();
    const duplicate = { ...observations[0], ...conflict };
    for (const rows of [
      [...observations, duplicate],
      [duplicate, ...observations],
      [duplicate, ...observations, duplicate],
    ]) {
      const results = evaluateGuardrails(input(rows));
      assert.equal(results[0].status, "INCONCLUSIVE");
      assert.match(results[0].reason, /conflicting duplicate/i);
      if ("metric" in conflict) assert.equal(results[1].status, "INCONCLUSIVE");
    }
  });
}

test("expired conflicting copies cannot refresh a current-step id", () => {
  const observations = rates("error_rate", 400, 4, 400, 4).map((row) => ({
    ...row,
    occurredAt: 90_000,
  }));
  const old = { ...observations[0], occurredAt: 20_000 };
  assert.equal(check([...observations, old], {}, { now: 90_000 }).status, "INCONCLUSIVE");
});

test("future observations cannot supplement counts or turn otherwise healthy evidence healthy", () => {
  const observations = rates("error_rate", 400, 4, 400, 4);
  const future = { ...observations[0], id: "future", occurredAt: now + 1 };
  const result = check([...observations, future]);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.match(result.reason, /future/i);
  assert.equal(result.baselineSamples, 400);
  assert.equal(check([future]).status, "INCONCLUSIVE");
});

test("both variations require fresh telemetry, with a strict 30s freshness boundary", () => {
  for (const variation of ["baseline", "enabled"] as const) {
    for (const age of [30_000, 30_001]) {
      const observations = rates("error_rate", 400, 4, 400, 4).map((row) => ({
        ...row,
        occurredAt: row.variation === variation ? now - age : now,
      }));
      const result = check(observations);
      assert.equal(result.status, "INSUFFICIENT");
      assert.match(result.reason, /stale/i);
    }
  }
  const fresh = rates("error_rate", 400, 4, 400, 4).map((row) => ({ ...row, occurredAt: 30_001 }));
  assert.equal(check(fresh).status, "HEALTHY");
});

test("replaying an otherwise healthy prior cycle cannot keep advancing", () => {
  const observations = demo();
  assert.ok(evaluateGuardrails(input(observations)).every((result) => result.status === "HEALTHY"));
  const replayed = evaluateGuardrails(input([...observations, ...observations], { now: 90_000 }));
  assert.ok(replayed.every((result) => result.status === "INSUFFICIENT"));
  assert.ok(replayed.every((result) => /stale/i.test(result.reason)));
});

for (const metric of ["error_rate", "conversion", "latency_ms"] as const) {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    ...(metric === "latency_ms" ? [] : [0.5, 2]),
  ]) {
    test(`${metric} rejects invalid value ${value} alongside healthy evidence`, () => {
      const observations = demo();
      const bad = { ...observations.find((row) => row.metric === metric)!, id: "invalid", value };
      const result = evaluateGuardrails(input([...observations, bad])).find(
        (row) => row.metric === metric,
      )!;
      assert.equal(result.status, "INCONCLUSIVE");
      assert.match(result.reason, /invalid/i);
    });
  }
}

test("malformed variation, timestamp, id, metric, and scope fail closed without throwing", () => {
  const observations = demo();
  for (const patch of [
    { variation: "unknown" },
    { occurredAt: NaN },
    { occurredAt: Infinity },
    { occurredAt: -1 },
    { id: "" },
    { id: undefined },
    { metric: "unknown" },
    { stepVersion: NaN },
    { flagKey: undefined },
    { value: "0" },
  ]) {
    const bad = { ...observations[0], id: "invalid", ...patch } as MetricObservation;
    assert.equal(evaluateGuardrails(input([...observations, bad]))[0].status, "INCONCLUSIVE");
  }
  assert.ok(
    evaluateGuardrails(input([...observations, null as unknown as MetricObservation])).every(
      (result) => result.status === "INCONCLUSIVE",
    ),
  );
});

test("invalid evaluator inputs and invalid guardrail configuration fail closed", () => {
  for (const overrides of [
    { now: NaN },
    { now: Infinity },
    { now: -1 },
    { now: 0, stepStartedAt: 1 },
    { stepStartedAt: NaN },
    { stepStartedAt: -1 },
    { stepVersion: -1 },
    { stepVersion: 0.5 },
    { scope: { ...scope, flagKey: "" } },
    { observations: null as unknown as MetricObservation[] },
  ]) {
    assert.ok(
      evaluateGuardrails(input(demo(), overrides)).every(
        (result) => result.status === "INCONCLUSIVE",
      ),
    );
  }
  for (const guard of [
    { threshold: NaN },
    { threshold: Infinity },
    { threshold: 0 },
    { threshold: -0.1 },
    { threshold: 1.1 },
    { minSamples: 0 },
    { minSamples: 20.5 },
    { minSamples: 10_001 },
    { windowSeconds: 0 },
    { windowSeconds: 30.5 },
    { windowSeconds: 3_601 },
  ]) {
    const result = check(demo(), guard);
    assert.equal(result.status, "INCONCLUSIVE");
    assert.match(result.reason, /configuration/i);
  }
  const duplicate = defaultRampPolicy.guardrails[0];
  assert.ok(
    evaluateGuardrails(input(demo(), { guardrails: [duplicate, duplicate] })).every(
      (result) => result.status === "INCONCLUSIVE",
    ),
  );
});

test("latency uses nearest-rank p95, not mean, maximum, or interpolated percentile", () => {
  for (const count of [20, 21, 39, 40, 41, 100, 101]) {
    const observations = [
      ...samples("latency_ms", "baseline", count, (index) => count - index),
      ...samples("latency_ms", "enabled", count, (index) => 2 * (count - index)),
    ];
    const result = check(observations, { metric: "latency_ms", threshold: 1 });
    assert.equal(result.baseline, Math.ceil(0.95 * count));
    assert.equal(result.enabled, 2 * Math.ceil(0.95 * count));
    assert.equal(result.delta, 1);
    assert.equal(result.status, "BREACHED");
  }
});

test("nearest-rank p95 handles repeated values, fractional milliseconds, and a high outlier", () => {
  const observations = [
    ...samples("latency_ms", "baseline", 20, (index) => (index === 19 ? 10_000 : 120.5)),
    ...samples("latency_ms", "enabled", 20, (index) => (index === 19 ? 100_000 : 125.5)),
  ];
  const result = check(observations, { metric: "latency_ms", threshold: 0.2 });
  assert.equal(result.baseline, 120.5);
  assert.equal(result.enabled, 125.5);
  assert.equal(result.status, "HEALTHY");
});

test("latency thresholds are inclusive relative increases and improvements are healthy", () => {
  for (const [value, status] of [
    [144, "BREACHED"],
    [143.999, "HEALTHY"],
    [120, "HEALTHY"],
    [0, "HEALTHY"],
  ] as const) {
    const result = check(
      [
        ...samples("latency_ms", "baseline", 20, 120),
        ...samples("latency_ms", "enabled", 20, value),
      ],
      { metric: "latency_ms", threshold: 0.2 },
    );
    assert.equal(result.status, status);
    close(result.delta, (value - 120) / 120);
  }
});

test("zero latency baseline and unrepresentable relative increases remain inconclusive", () => {
  for (const [baseline, enabled] of [
    [0, 0],
    [0, 1],
    [Number.MIN_VALUE, Number.MAX_VALUE],
  ]) {
    const result = check(
      [
        ...samples("latency_ms", "baseline", 20, baseline),
        ...samples("latency_ms", "enabled", 20, enabled),
      ],
      { metric: "latency_ms", threshold: 0.2 },
    );
    assert.equal(result.status, "INCONCLUSIVE");
    assert.equal(result.delta, null);
    assert.equal(result.zScore, null);
    assert.doesNotThrow(() => JSON.stringify(result));
  }
});

test("bounded p95 heap matches an independent sorted oracle on deterministic mixed samples", () => {
  const observations = [
    ...samples("latency_ms", "baseline", 2_003, (index) => ((index * 7_919) % 997) / 10),
    ...samples("latency_ms", "enabled", 1_009, (index) => ((index * 1_543) % 1_021) / 10),
  ];
  const result = check(observations, { metric: "latency_ms", threshold: 0.2 });
  for (const variation of ["baseline", "enabled"] as const) {
    const ordered = observations
      .filter((row) => row.variation === variation)
      .map((row) => row.value)
      .sort((a, b) => a - b);
    assert.equal(result[variation], ordered[Math.ceil(0.95 * ordered.length) - 1]);
  }
  assert.deepEqual(
    check([...observations].reverse(), { metric: "latency_ms", threshold: 0.2 }),
    result,
  );
});

test("oversized input fails closed before processing or selecting a favorable prefix", () => {
  const observations = Array<MetricObservation>(200_001);
  Object.defineProperty(observations, 0, {
    get() {
      throw new Error("must not scan oversized input");
    },
  });
  const result = check(observations);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.match(result.reason, /observation limit/i);
});

test("per-variation sample cap fails closed and does not truncate the p95 tail", () => {
  const observations = [
    ...samples("latency_ms", "baseline", 50_001, 100),
    ...samples("latency_ms", "enabled", 20, 100),
  ];
  const result = check(observations, { metric: "latency_ms", threshold: 0.2 });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.baselineSamples, 50_001);
  assert.match(result.reason, /sample limit/i);
});

test("evaluation is deterministic, does not mutate frozen evidence, and supports no guardrails", () => {
  const observations = Object.freeze(demo().map((row) => Object.freeze(row)));
  const request = Object.freeze(
    input(observations, {
      guardrails: Object.freeze(
        defaultRampPolicy.guardrails.map((guard) => Object.freeze({ ...guard })),
      ),
      scope: Object.freeze({ ...scope }),
    }),
  );
  assert.deepEqual(evaluateGuardrails(request), evaluateGuardrails(request));
  assert.deepEqual(evaluateGuardrails(input(observations, { guardrails: [] })), []);
});
