import { decideRollout } from "./engine";
import { evaluateGuardrails } from "./statistics";
import {
  defaultRampPolicy,
  rampPolicySchema,
  type MetricObservation,
  type RampPolicy,
  type RolloutAudit,
  type RolloutState,
} from "./types";

export function createDemoRollout(policy: RampPolicy = defaultRampPolicy): RolloutState {
  return {
    flagKey: "checkout_v2",
    environmentId: "demo-production",
    policy: rampPolicySchema.parse(policy),
    optedIn: false,
    status: "idle",
    enabled: false,
    rolloutPercent: 0,
    stepIndex: -1,
    stepVersion: 0,
    stepStartedAt: null,
    lastEvaluatedAt: null,
    nextCheckAt: null,
    now: 0,
    observations: [],
    history: [],
    audit: [],
    notifications: [],
  };
}

function snapshot(state: RolloutState) {
  return { enabled: state.enabled, rolloutPercent: state.rolloutPercent };
}

/** Demo records only. A real write adapter must persist flag+audit+notification atomically. */
function record(
  before: RolloutState,
  after: RolloutState,
  action: RolloutAudit["action"],
  summary: string,
  automatic = false,
): RolloutState {
  const id = `demo-${after.stepVersion}-${after.now}-${action}-${after.audit.length}`;
  return {
    ...after,
    audit: [
      ...after.audit,
      {
        id,
        createdAt: after.now,
        actor: automatic ? ("FlagForge Guard" as const) : ("Demo operator" as const),
        action,
        before: snapshot(before),
        after: snapshot(after),
        summary,
      },
    ].slice(-200),
    notifications: [...after.notifications, { id, at: after.now, message: summary }].slice(-50),
  };
}

export function setOptIn(state: RolloutState, optedIn: boolean): RolloutState {
  if (optedIn === state.optedIn) return state;
  const next = { ...state, optedIn };
  if (!optedIn && (state.status === "running" || state.status === "paused")) {
    return record(
      state,
      { ...next, status: "paused", nextCheckAt: null },
      "OPT_OUT",
      "Opted out. Automation stopped; the demo flag keeps its current setting.",
    );
  }
  return next;
}

function enterStep(state: RolloutState, index: number): RolloutState {
  return {
    ...state,
    enabled: true,
    rolloutPercent: state.policy.steps[index],
    stepIndex: index,
    stepVersion: state.stepVersion + 1,
    stepStartedAt: state.now,
    nextCheckAt: state.now + state.policy.monitorIntervalSeconds * 1000,
    // Evidence belongs to one version. Do not advance twice on the previous step's metrics.
    observations: [],
  };
}

export function startRollout(state: RolloutState): RolloutState {
  if (state.status !== "idle") throw new Error("Reset the demo before starting another rollout.");
  if (!state.optedIn) throw new Error("Opt in before starting automated rollout.");
  const policy = rampPolicySchema.parse(state.policy);
  const next = enterStep({ ...state, policy, status: "running" }, 0);
  return record(
    state,
    next,
    "START",
    `Started the demo at ${next.rolloutPercent}%. Waiting for fresh guardrail evidence.`,
  );
}

export function pauseRollout(state: RolloutState): RolloutState {
  if (state.status !== "running") return state;
  return record(
    state,
    { ...state, status: "paused", nextCheckAt: null },
    "PAUSE",
    "Automation paused, including automatic rollback. The demo flag is unchanged.",
  );
}

export function resumeRollout(state: RolloutState): RolloutState {
  if (state.status !== "paused" || !state.optedIn || !state.enabled)
    throw new Error("Resume requires an opted-in, paused, enabled rollout.");
  if (state.policy.steps[state.stepIndex] !== state.rolloutPercent)
    throw new Error("The rollout no longer matches its policy. Reset and review.");
  const next = enterStep({ ...state, status: "running" }, state.stepIndex);
  return record(state, next, "RESUME", "Automation resumed with a fresh hold and evidence window.");
}

export function rollBackNow(state: RolloutState): RolloutState {
  if (!state.enabled) return state;
  return record(
    state,
    { ...state, enabled: false, rolloutPercent: 0, status: "rolled_back", nextCheckAt: null },
    "MANUAL_ROLLBACK",
    "Manually rolled back: the demo flag is off at 0%. No automatic restart is scheduled.",
  );
}

export function advanceNow(state: RolloutState): RolloutState {
  if (
    !state.optedIn ||
    !state.enabled ||
    !["running", "paused"].includes(state.status) ||
    state.stepStartedAt === null
  )
    throw new Error("Manual advance requires an opted-in active rollout.");
  const policy = rampPolicySchema.parse(state.policy);
  if (policy.steps[state.stepIndex] !== state.rolloutPercent)
    throw new Error("The rollout no longer matches its policy.");
  if (state.stepIndex >= policy.steps.length - 1)
    throw new Error("The rollout is already at its final step.");
  const checks = evaluateGuardrails({
    observations: state.observations,
    guardrails: policy.guardrails,
    scope: state,
    stepVersion: state.stepVersion,
    stepStartedAt: state.stepStartedAt,
    now: state.now,
  });
  if (checks.some((check) => check.status !== "HEALTHY"))
    throw new Error(
      "Manual advance requires fresh, sufficient, healthy evidence for every guardrail.",
    );
  const next = enterStep(state, state.stepIndex + 1);
  return record(
    state,
    { ...next, nextCheckAt: state.status === "paused" ? null : next.nextCheckAt },
    "MANUAL_ADVANCE",
    `Manually advanced only to ${next.rolloutPercent}%. A new hold and evidence window begin.`,
  );
}

/** Balanced synthetic cohorts, independent of the rollout share: never presented as live traffic. */
export function simulateObservations(
  state: RolloutState,
  now: number,
  injectErrors: boolean,
): MetricObservation[] {
  const observations: MetricObservation[] = [];
  for (const variation of ["baseline", "enabled"] as const) {
    const degraded = variation === "enabled" && injectErrors;
    for (let index = 0; index < 200; index++) {
      const occurredAt = now - 30_000 + (index + 1) * 150;
      const values = {
        error_rate: Number(index < (degraded ? 40 : 2)),
        conversion: Number(index < (variation === "enabled" ? 44 : 40)),
        latency_ms:
          index < 180
            ? degraded
              ? 250
              : 90
            : index < 198
              ? degraded
                ? 300
                : variation === "enabled"
                  ? 125
                  : 120
              : 400,
      };
      for (const metric of ["error_rate", "latency_ms", "conversion"] as const) {
        observations.push({
          flagKey: state.flagKey,
          environmentId: state.environmentId,
          id: `sample-${state.stepVersion}-${now}-${variation}-${index}-${metric}`,
          variation,
          metric,
          value: values[metric],
          occurredAt,
          stepVersion: state.stepVersion,
        });
      }
    }
  }
  return observations;
}

/** One due monitoring transition, at most one step. Pure and idempotent at a cycle timestamp. */
export function monitorRollout(
  state: RolloutState,
  observations: readonly MetricObservation[],
  now: number,
): RolloutState {
  if (state.status !== "running" || !state.optedIn || !state.enabled) return state;
  if (!Number.isSafeInteger(now) || now < state.now)
    throw new Error("Monitoring time must move forward in whole milliseconds.");
  if (
    state.nextCheckAt === null ||
    now < state.nextCheckAt ||
    (state.lastEvaluatedAt !== null && now <= state.lastEvaluatedAt)
  )
    return state;
  const policy = rampPolicySchema.parse(state.policy);
  if (observations.length > 200_000)
    throw new Error("Too many observations for one monitoring cycle.");
  const from = Math.max(
    state.stepStartedAt ?? now,
    now - Math.max(...policy.guardrails.map((guard) => guard.windowSeconds)) * 1000,
  );
  // Retain the complete active window; malformed/future input stays visible to the evaluator.
  const retained = state.observations.filter(
    (event) => event.occurredAt >= from || !Number.isFinite(event.occurredAt),
  );
  const combined = [...retained, ...observations];
  if (combined.length > 200_000)
    throw new Error(
      "Active telemetry exceeds the monitoring limit. No truncated decision was made.",
    );
  const candidate: RolloutState = { ...state, policy, now, observations: combined };
  const result = decideRollout(candidate, now);
  let next: RolloutState = {
    ...candidate,
    lastEvaluatedAt: now,
    nextCheckAt: now + policy.monitorIntervalSeconds * 1000,
    history: [
      ...state.history,
      { ...result, at: now, stepVersion: state.stepVersion, rolloutPercent: state.rolloutPercent },
    ].slice(-200),
  };
  if (result.decision === "ROLLBACK") {
    next = record(
      state,
      { ...next, enabled: false, rolloutPercent: 0, status: "rolled_back", nextCheckAt: null },
      "AUTO_ROLLBACK",
      result.reasons[0],
      true,
    );
  } else if (result.decision === "ADVANCE") {
    if (result.complete) {
      next = record(
        state,
        { ...next, status: "completed", nextCheckAt: null },
        "COMPLETE",
        result.reasons[0],
        true,
      );
    } else {
      next = record(
        state,
        enterStep(next, state.stepIndex + 1),
        "AUTO_RAMP",
        result.reasons[0],
        true,
      );
    }
  }
  return next;
}

/** A real 30-second worker can call monitorRollout; only this fixture invents metrics/time. */
export function simulateCycle(
  state: RolloutState,
  options: { traffic: boolean; injectErrors: boolean },
): RolloutState {
  if (state.status !== "running" || !state.optedIn) return state;
  const now = state.now + state.policy.monitorIntervalSeconds * 1000;
  return monitorRollout(
    state,
    options.traffic ? simulateObservations(state, now, options.injectErrors) : [],
    now,
  );
}
