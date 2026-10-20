import { evaluateGuardrails } from "./statistics";
import { rampPolicySchema, type RolloutDecision, type RolloutState } from "./types";

const hold = (reason: string): RolloutDecision => ({
  decision: "HOLD",
  reasons: [reason],
  checks: [],
  breachedMetrics: [],
  complete: false,
});

/** Statistics alone decide. No model, network, database, timer, or mutation is involved. */
export function decideRollout(state: RolloutState, now: number): RolloutDecision {
  const policy = rampPolicySchema.parse(state.policy);
  if (!Number.isSafeInteger(now) || now < state.now)
    return hold("Clock is invalid or moved backwards.");
  if (!state.optedIn) return hold("Automation is not opted in for this flag.");
  if (state.status !== "running")
    return hold("Automation is not running; no automatic change is permitted.");
  if (!state.enabled) return hold("The flag is off; automation cannot enable it implicitly.");
  if (
    state.stepStartedAt === null ||
    state.stepStartedAt > now ||
    !Number.isSafeInteger(state.stepIndex) ||
    state.stepIndex < 0 ||
    policy.steps[state.stepIndex] !== state.rolloutPercent ||
    !Number.isSafeInteger(state.stepVersion) ||
    state.stepVersion < 1
  )
    return hold("The saved rollout no longer matches its policy step. Review before resuming.");
  if (state.lastEvaluatedAt !== null && now <= state.lastEvaluatedAt)
    return hold("This monitoring cycle has already been evaluated.");
  if (state.nextCheckAt === null || now < state.nextCheckAt)
    return hold("The next monitoring cycle is not due yet.");

  const checks = evaluateGuardrails({
    observations: state.observations,
    guardrails: policy.guardrails,
    scope: { flagKey: state.flagKey, environmentId: state.environmentId },
    stepVersion: state.stepVersion,
    stepStartedAt: state.stepStartedAt,
    now,
  });
  const breached = checks.filter((check) => check.status === "BREACHED");
  if (breached.length) {
    return {
      decision: "ROLLBACK",
      checks,
      breachedMetrics: breached.map((check) => check.metric),
      complete: false,
      reasons: [
        `Rollback: ${breached.map((check) => check.metric).join(", ")} breached the configured guardrail.`,
        ...breached.map((check) => `${check.metric}: ${check.reason}`),
      ],
    };
  }
  const blocked = checks.filter((check) => check.status !== "HEALTHY");
  if (blocked.length)
    return {
      decision: "HOLD",
      checks,
      breachedMetrics: [],
      complete: false,
      reasons: [
        "Hold: every configured guardrail needs fresh, sufficient, healthy evidence.",
        ...blocked.map((check) => `${check.metric}: ${check.reason}`),
      ],
    };
  if (now - state.stepStartedAt < policy.holdSeconds * 1000)
    return {
      decision: "HOLD",
      checks,
      breachedMetrics: [],
      complete: false,
      reasons: [
        `Hold: metrics are healthy, but the ${policy.holdSeconds}s hold for this step has not elapsed.`,
      ],
    };
  const complete = state.stepIndex === policy.steps.length - 1;
  return {
    decision: "ADVANCE",
    checks,
    breachedMetrics: [],
    complete,
    reasons: [
      complete
        ? "Complete: the final 100% step finished its hold with healthy evidence. No further changes are scheduled."
        : `Advance: all guardrails are healthy after the ${policy.holdSeconds}s hold. Move only to the next step at ${policy.steps[state.stepIndex + 1]}%.`,
    ],
  };
}
