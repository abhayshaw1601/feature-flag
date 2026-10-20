import assert from "node:assert/strict";
import { test } from "node:test";
import { autoRolloutOutputSchema } from "@flagforge/contracts";
import { decideRollout } from "../lib/auto-rollout/engine";
import { deterministicExplanation, explainRollout } from "../lib/auto-rollout/explanation";
import {
  advanceNow,
  createDemoRollout,
  monitorRollout,
  pauseRollout,
  resumeRollout,
  rollBackNow,
  setOptIn,
  simulateCycle,
  simulateObservations,
  startRollout,
} from "../lib/auto-rollout/simulator";
import { defaultRampPolicy, rampPolicySchema, type RolloutState } from "../lib/auto-rollout/types";

const start = () => startRollout(setOptIn(createDemoRollout(), true));
const cycle = (state: RolloutState, injectErrors = false) =>
  simulateCycle(state, { traffic: true, injectErrors });

test("automation defaults off and cannot start or mutate without explicit opt-in", () => {
  const state = createDemoRollout();
  assert.equal(state.optedIn, false);
  assert.equal(state.enabled, false);
  assert.throws(() => startRollout(state), /Opt in/);
  assert.equal(simulateCycle(state, { traffic: true, injectErrors: true }), state);
  assert.equal(decideRollout(state, 30_000).decision, "HOLD");
});

test("healthy four-step ramp completes after each full hold, without skipping the final hold", () => {
  let state = start();
  const states = [];
  for (let index = 0; index < 8; index++) {
    state = cycle(state);
    states.push([state.now, state.rolloutPercent, state.status]);
  }
  assert.deepEqual(states, [
    [30_000, 5, "running"],
    [60_000, 25, "running"],
    [90_000, 25, "running"],
    [120_000, 50, "running"],
    [150_000, 50, "running"],
    [180_000, 100, "running"],
    [210_000, 100, "running"],
    [240_000, 100, "completed"],
  ]);
  assert.equal(state.enabled, true);
  assert.equal(state.nextCheckAt, null);
  assert.equal(state.audit.filter((event) => event.action === "AUTO_RAMP").length, 3);
  assert.equal(state.audit.filter((event) => event.action === "COMPLETE").length, 1);
  assert.equal(state.audit.at(-1)?.actor, "FlagForge Guard");
  assert.equal(cycle(state, true), state, "Completed automation must not restart itself");
});

test("injected errors roll back within two monitoring cycles and identify breached metrics", () => {
  const state = cycle(cycle(start(), true), true);
  assert.equal(state.now, 60_000);
  assert.equal(state.status, "rolled_back");
  assert.equal(state.enabled, false);
  assert.equal(state.rolloutPercent, 0);
  assert.equal(state.nextCheckAt, null);
  const decision = state.history.at(-1)!;
  assert.equal(decision.decision, "ROLLBACK");
  assert.ok(decision.breachedMetrics.includes("error_rate"));
  assert.ok(decision.breachedMetrics.includes("latency_ms"));
  assert.equal(state.audit.at(-1)?.actor, "FlagForge Guard");
  assert.deepEqual(state.audit.at(-1)?.before, { enabled: true, rolloutPercent: 5 });
  assert.deepEqual(state.audit.at(-1)?.after, { enabled: false, rolloutPercent: 0 });
  assert.ok(state.notifications.at(-1)?.message.includes("error_rate"));
  const explanation = deterministicExplanation(decision);
  assert.ok(autoRolloutOutputSchema.safeParse(explanation).success);
  assert.ok(explanation.incidentNote.includes("error_rate"));
  assert.equal(cycle(state), state);
});

test("a breach takes precedence over hold time and final completion", () => {
  const longHold = startRollout(
    setOptIn(createDemoRollout({ ...defaultRampPolicy, holdSeconds: 600 }), true),
  );
  assert.equal(cycle(cycle(longHold, true), true).status, "rolled_back");
  let state = start();
  for (let index = 0; index < 6; index++) state = cycle(state);
  assert.equal(state.rolloutPercent, 100);
  assert.equal(cycle(cycle(state, true), true).status, "rolled_back");
});

test("no traffic never advances; stopped traffic becomes stale instead of healthy", () => {
  let state = start();
  for (let index = 0; index < 20; index++)
    state = simulateCycle(state, { traffic: false, injectErrors: false });
  assert.equal(state.rolloutPercent, 5);
  assert.equal(state.history.at(-1)?.decision, "HOLD");
  assert.ok(state.history.at(-1)?.checks.every((check) => check.status === "INSUFFICIENT"));
  let longHold = startRollout(
    setOptIn(createDemoRollout({ ...defaultRampPolicy, holdSeconds: 120 }), true),
  );
  longHold = cycle(cycle(longHold));
  assert.ok(longHold.history.at(-1)?.checks.every((check) => check.status === "HEALTHY"));
  longHold = simulateCycle(longHold, { traffic: false, injectErrors: false });
  assert.equal(longHold.history.at(-1)?.decision, "HOLD");
  assert.ok(longHold.history.at(-1)?.checks.every((check) => check.status === "INSUFFICIENT"));
});

test("opt-out stops automation without disabling the flag or automatically resuming", () => {
  const before = cycle(start());
  const optedOut = setOptIn(before, false);
  assert.equal(optedOut.status, "paused");
  assert.equal(optedOut.rolloutPercent, 5);
  assert.equal(optedOut.enabled, true);
  assert.equal(cycle(optedOut, true), optedOut);
  assert.throws(() => resumeRollout(optedOut), /opted-in/);
  const optedBack = setOptIn(optedOut, true);
  assert.equal(optedBack.status, "paused");
  assert.equal(optedBack.nextCheckAt, null);
});

test("pause freezes the virtual clock; resume starts a new version, window and hold", () => {
  const before = cycle(start());
  const paused = pauseRollout(before);
  assert.equal(cycle(paused), paused);
  const resumed = resumeRollout(paused);
  assert.equal(resumed.now, 30_000);
  assert.equal(resumed.stepStartedAt, 30_000);
  assert.equal(resumed.stepVersion, before.stepVersion + 1);
  assert.equal(resumed.observations.length, 0);
  assert.equal(cycle(resumed).rolloutPercent, 5);
  assert.equal(cycle(cycle(resumed)).rolloutPercent, 25);
});

test("manual advance can skip remaining hold only with current healthy evidence, one step at a time", () => {
  let state = startRollout(
    setOptIn(createDemoRollout({ ...defaultRampPolicy, holdSeconds: 300 }), true),
  );
  assert.throws(() => advanceNow(state), /healthy evidence/);
  state = cycle(cycle(state));
  const next = advanceNow(state);
  assert.equal(next.rolloutPercent, 25);
  assert.equal(next.observations.length, 0);
  assert.equal(next.stepStartedAt, 60_000);
  assert.equal(next.audit.at(-1)?.actor, "Demo operator");
  assert.throws(() => advanceNow(next), /healthy evidence/);
  assert.throws(() => advanceNow(setOptIn(state, false)), /opted-in/);
  const pausedNext = advanceNow(pauseRollout(state));
  assert.equal(pausedNext.status, "paused");
  assert.equal(pausedNext.nextCheckAt, null);
});

test("manual rollback is immediate while paused/opted out and is idempotent", () => {
  const state = setOptIn(cycle(start()), false);
  const rolled = rollBackNow(state);
  assert.equal(rolled.enabled, false);
  assert.equal(rolled.rolloutPercent, 0);
  assert.equal(rolled.audit.at(-1)?.action, "MANUAL_ROLLBACK");
  assert.equal(rollBackNow(rolled), rolled);
  assert.throws(() => startRollout(rolled), /Reset/);
  assert.throws(() => resumeRollout(rolled), /Resume requires/);
});

test("repeat or early monitor calls cannot double-advance, append duplicate audits or consume metrics", () => {
  const initial = start();
  const early = monitorRollout(initial, simulateObservations(initial, 30_000, false), 29_999);
  assert.equal(early, initial);
  const after = cycle(cycle(initial));
  const duplicate = monitorRollout(after, simulateObservations(initial, 60_000, false), 60_000);
  assert.equal(duplicate, after);
  assert.equal(after.audit.length, 2);
  assert.throws(() => monitorRollout(after, [], 59_999), /forward/);
});

test("default and caller-owned policies are cloned; transitions do not mutate input", () => {
  const policy = structuredClone(defaultRampPolicy);
  const initial = createDemoRollout(policy);
  policy.steps[0] = 99;
  assert.equal(initial.policy.steps[0], 5);
  const state = start();
  const before = JSON.stringify(state);
  cycle(state);
  pauseRollout(state);
  rollBackNow(state);
  assert.equal(JSON.stringify(state), before);
  assert.equal(initial.optedIn, false);
});

test("scope and step version boundaries prevent contaminated evidence from advancing", () => {
  const state = start();
  const observations = simulateObservations(state, 60_000, false);
  for (const transform of [
    (event: (typeof observations)[number]) => ({ ...event, environmentId: "foreign" }),
    (event: (typeof observations)[number]) => ({ ...event, flagKey: "foreign" }),
    (event: (typeof observations)[number]) => ({ ...event, stepVersion: 0 }),
  ]) {
    const next = monitorRollout(state, observations.map(transform), 60_000);
    assert.equal(next.rolloutPercent, 5);
    assert.equal(next.history.at(-1)?.decision, "HOLD");
  }
});

test("invalid or externally changed policy cannot silently enable automatic advances", () => {
  for (const steps of [[0, 100], [5, 5, 100], [25, 5, 100], [5, 50], [100]]) {
    assert.equal(rampPolicySchema.safeParse({ ...defaultRampPolicy, steps }).success, false);
  }
  assert.equal(rampPolicySchema.safeParse({ ...defaultRampPolicy, guardrails: [] }).success, false);
  assert.throws(() => createDemoRollout({ ...defaultRampPolicy, holdSeconds: 0 }));
  const mismatch = { ...start(), rolloutPercent: 50 };
  assert.equal(cycle(cycle(mismatch)).history.at(-1)?.decision, "HOLD");
  assert.equal(cycle(cycle(mismatch)).rolloutPercent, 50);
  const disabled = { ...start(), enabled: false };
  assert.equal(cycle(disabled), disabled);
});

test("sample injection is reproducible and degrades only the enabled variation", () => {
  const state = start();
  const normal = simulateObservations(state, 30_000, false);
  const degraded = simulateObservations(state, 30_000, true);
  assert.equal(normal.length, 1200);
  assert.deepEqual(normal, simulateObservations(state, 30_000, false));
  assert.deepEqual(
    normal.filter((event) => event.variation === "baseline"),
    degraded.filter((event) => event.variation === "baseline"),
  );
  const errors = (events: typeof normal) =>
    events
      .filter((event) => event.variation === "enabled" && event.metric === "error_rate")
      .reduce((total, event) => total + event.value, 0);
  assert.equal(errors(normal), 2);
  assert.equal(errors(degraded), 40);
});

test("model output cannot reverse rollback or change the list of breached metrics", async () => {
  const state = cycle(cycle(start(), true), true);
  const decision = state.history.at(-1)!;
  const expected = deterministicExplanation(decision);
  const badOutputs = [
    { ...expected, decision: "ADVANCE", explanation: "Ship immediately" },
    { ...expected, breachedMetrics: [] },
    { ...expected, breachedMetrics: ["invented_metric"] },
    { ...expected, explanation: "  " },
    { malformed: true },
  ];
  for (const output of badOutputs) {
    const result = await explainRollout(decision, async () => output);
    assert.equal(result.source, "fallback");
    assert.deepEqual(result.output, expected);
  }
  assert.equal(state.enabled, false, "Explanation never controls or postpones rollback");
});

test("explanation falls back on unavailable generation and passes only a cloned fact set", async () => {
  const decision = cycle(cycle(start(), true), true).history.at(-1)!;
  const before = JSON.stringify(decision);
  const failed = await explainRollout(decision, async (copy) => {
    copy.decision = "ADVANCE";
    throw new Error("private provider payload");
  });
  assert.equal(failed.source, "fallback");
  assert.equal(JSON.stringify(decision), before);
  assert.ok(!JSON.stringify(failed).includes("private provider payload"));
  const mock = await explainRollout(decision);
  assert.equal(mock.source, "deterministic");
  const generated = await explainRollout(decision, async () => ({
    ...deterministicExplanation(decision),
    explanation: "  Error guard breached.\nReview before retrying. ",
  }));
  assert.equal(generated.source, "generated");
  assert.equal(generated.output.explanation, "Error guard breached. Review before retrying.");
});

test("history and notification storage are bounded during an indefinite no-data hold", () => {
  let state = start();
  for (let index = 0; index < 220; index++)
    state = simulateCycle(state, { traffic: false, injectErrors: false });
  assert.equal(state.history.length, 200);
  assert.equal(state.observations.length, 0);
  assert.equal(state.audit.length, 1, "HOLD does not invent flag writes");
});
