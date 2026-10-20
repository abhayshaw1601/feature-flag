import assert from "node:assert/strict";
import test from "node:test";
import {
  createPolicyDraft,
  formatDelta,
  formatMetric,
  formatVirtualTime,
  validatePolicyDraft,
} from "./monitor-format";

test("policy fields preserve percentage-point units and reject unsafe ramp shapes", () => {
  const draft = createPolicyDraft();
  const parsed = validatePolicyDraft({
    ...draft,
    errorThreshold: "2.5",
    holdSeconds: "90",
    steps: "10, 40, 100",
  });
  assert.equal(
    parsed.policy?.guardrails.find((guard) => guard.metric === "error_rate")?.threshold,
    0.025,
  );
  assert.equal(parsed.policy?.holdSeconds, 90);
  assert.deepEqual(parsed.policy?.steps, [10, 40, 100]);
  for (const steps of [
    "5,,100",
    "0,100",
    "5,5,100",
    "50,25,100",
    "5,99",
    "5.5,100",
    "100",
    "5 25 100",
    "5,100,",
  ]) {
    const result = validatePolicyDraft({ ...draft, steps });
    assert.equal(result.policy, null, steps);
    assert.ok(result.errors.steps, steps);
  }
});

test("blank, fractional, nonfinite, and out-of-range settings never become valid zeros", () => {
  const draft = createPolicyDraft();
  for (const holdSeconds of ["", "29", "30.5", "86401", "Infinity", "1e3"]) {
    assert.ok(validatePolicyDraft({ ...draft, holdSeconds }).errors.holdSeconds, holdSeconds);
  }
  for (const errorThreshold of ["", "0", "-2", "100.01", "Infinity", "NaN"]) {
    assert.ok(
      validatePolicyDraft({ ...draft, errorThreshold }).errors.errorThreshold,
      errorThreshold,
    );
  }
  assert.ok(validatePolicyDraft(draft).policy);
  assert.ok(validatePolicyDraft({ ...draft, errorThreshold: ".5", holdSeconds: "30" }).policy);
});

test("missing evidence remains distinct from zero, with correct metric and deterioration units", () => {
  assert.equal(formatMetric("error_rate", null), "—");
  assert.equal(formatMetric("latency_ms", undefined), "—");
  assert.equal(formatMetric("conversion", 0), "0.00%");
  assert.equal(formatMetric("error_rate", 0.012), "1.20%");
  assert.equal(formatMetric("latency_ms", 120.25), "120.3 ms");
  assert.equal(formatDelta("error_rate", 0.02), "+2.00 pp");
  assert.equal(formatDelta("latency_ms", 0.2), "+20.00 %");
  assert.equal(formatDelta("conversion", -0.05), "-5.00 pp");
  assert.equal(formatDelta("error_rate", null), "—");
  assert.equal(formatDelta("error_rate", -0.00000001), "0.00 pp");
});

test("virtual elapsed time is independent of wall-clock dates and time zones", () => {
  assert.equal(formatVirtualTime(0), "T+0m 0s");
  assert.equal(formatVirtualTime(90_000), "T+1m 30s");
  assert.equal(formatVirtualTime(3_630_000), "T+1h 0m 30s");
});
