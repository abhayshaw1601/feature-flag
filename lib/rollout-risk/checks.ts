import { rolloutRiskOutputSchema, type RolloutRiskOutput, type Rule } from "@flagforge/contracts";
import {
  rolloutRiskInputSchema,
  targetingSnapshotSchema,
  type RolloutRiskInput,
  type TargetingSnapshot,
} from "./types";

type RiskLevel = RolloutRiskOutput["riskLevel"];
type Plan = RolloutRiskOutput["saferPlan"];
type Facts = {
  riskLevel: RiskLevel;
  reasons: string[];
  missingSafeguards: string[];
  canRamp: boolean;
  start: number;
  target: number;
};

const rank: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const sensitiveTags = new Set(["payments", "payment", "billing", "auth", "security"]);
const recentWindow = 15 * 60 * 1000;

// These are serve caps, never estimates of the combined audience of ordered rules.
// The first increase is at most 5 points for HIGH, otherwise 10. Later increases
// are at most 10/20/25 points for HIGH/MEDIUM/LOW, with an explicit hold per step.
const rampLimits = {
  LOW: { first: 10, next: 25, hold: "15 minutes" },
  MEDIUM: { first: 10, next: 20, hold: "30 minutes" },
  HIGH: { first: 5, next: 10, hold: "60 minutes" },
} satisfies Record<RiskLevel, { first: number; next: number; hold: string }>;

function cleanText(value: string): string {
  return value
    .replace(/[#*0-9]\uFE0F?\u20E3/gu, " ")
    .replace(
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u20E3]/gu,
      " ",
    )
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Z}\s]+/gu, " ")
    .trim();
}

function cleanList(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

// Condition/value order is immaterial (AND conditions, OR values). Descriptions
// are not targeting. Rule order, IDs, attributes, operators and values are.
function conditionsKey(rule: Rule): string {
  return JSON.stringify(
    rule.conditions
      .map((condition) =>
        JSON.stringify([
          condition.attribute,
          condition.operator,
          [...new Set(condition.values.map((value) => JSON.stringify(value)))].sort(),
        ]),
      )
      .sort(),
  );
}

function inspect(input: RolloutRiskInput, now: number): Facts {
  if (!Number.isFinite(now)) throw new RangeError("Assessment time must be finite milliseconds.");
  const { before, after } = input;
  const reasons: string[] = [];
  const missingSafeguards: string[] = [];
  const production = /(^|-)(prod|production)(-|$)/i.test(input.environmentKey);
  const sensitive = [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()))].filter((tag) =>
    sensitiveTags.has(tag),
  );
  const beforeRules = new Map(before.rules.rules.map((rule) => [rule.id, rule]));
  const afterRules = new Map(after.rules.rules.map((rule) => [rule.id, rule]));
  const removed = before.rules.rules.filter((rule) => !afterRules.has(rule.id)).length;
  const added = after.rules.rules.filter((rule) => !beforeRules.has(rule.id)).length;
  const changed = after.rules.rules.filter((rule) => {
    const previous = beforeRules.get(rule.id);
    return previous && conditionsKey(previous) !== conditionsKey(rule);
  }).length;
  const retainedBefore = before.rules.rules
    .filter((rule) => afterRules.has(rule.id))
    .map((r) => r.id);
  const retainedAfter = after.rules.rules
    .filter((rule) => beforeRules.has(rule.id))
    .map((r) => r.id);
  const reordered = JSON.stringify(retainedBefore) !== JSON.stringify(retainedAfter);
  const duplicateIds =
    beforeRules.size !== before.rules.rules.length || afterRules.size !== after.rules.rules.length;
  const structural = removed > 0 || added > 0 || changed > 0 || reordered || duplicateIds;

  reasons.push(
    production
      ? `Production environment: ${input.environmentKey}.`
      : `Environment ${input.environmentKey} is not classified as production.`,
  );
  if (sensitive.length) reasons.push(`Sensitive flag tags: ${sensitive.join(", ")}.`);
  if (!before.enabled && after.enabled) {
    reasons.push(
      "Enabling a previously disabled flag activates its saved serve percentages; the effective starting percentages are 0%.",
    );
  }
  if (!after.enabled)
    reasons.push(
      "The proposed flag is disabled; saved percentages do not expose users and no ramp is applied.",
    );
  if (removed)
    reasons.push(
      `Removed ${removed} targeting rule(s); users may fall through to another rule or the default when enabled.`,
    );
  if (added)
    reasons.push(
      `Added ${added} targeting rule(s); the matching audience and overlap are not known.`,
    );
  if (changed)
    reasons.push(
      `Changed conditions on ${changed} targeting rule(s); targeting may broaden even if percentages decrease.`,
    );
  if (reordered)
    reasons.push("Targeting rule order changed; first-match precedence can change exposure.");
  if (duplicateIds)
    reasons.push(
      "Duplicate rule IDs make per-rule comparisons ambiguous; targeting requires review.",
    );

  const increases: { from: number; to: number }[] = [];
  const defaultBefore = before.enabled ? before.rolloutPercent : 0;
  const defaultAfter = after.enabled ? after.rolloutPercent : 0;
  if (defaultAfter !== defaultBefore) {
    reasons.push(`Effective default serve changes from ${defaultBefore}% to ${defaultAfter}%.`);
  }
  if (defaultAfter > defaultBefore) increases.push({ from: defaultBefore, to: defaultAfter });
  for (const rule of after.rules.rules) {
    const previous = beforeRules.get(rule.id);
    const from = before.enabled && previous && !duplicateIds ? previous.serve.rolloutPercent : 0;
    const to = after.enabled ? rule.serve.rolloutPercent : 0;
    if (to > from) {
      increases.push({ from, to });
      reasons.push(
        duplicateIds
          ? `Rule ${rule.id} has a ${to}% serve for its matches; duplicate IDs prevent a reliable comparison with its prior serve.`
          : previous
            ? `Rule ${rule.id} serve increases from ${from}% to ${to}% for matching users; this is not the total audience percentage.`
            : `New rule ${rule.id} serves at ${to}% for its matches; prior exposure for this cohort is unknown.`,
      );
    }
  }

  const savedTarget = Math.max(
    after.rolloutPercent,
    ...after.rules.rules.map((rule) => rule.serve.rolloutPercent),
  );
  const target = after.enabled ? savedTarget : 0;
  const canRamp = target > 0 && (increases.length > 0 || structural);
  const jump = Math.max(0, ...increases.map(({ from, to }) => to - from));
  const reachesFullServe = increases.some(({ to }) => to === 100);
  if (defaultAfter === 100) {
    reasons.push(
      after.rules.rules.length === 0
        ? "The proposed default is 100% with no targeting rules: an all-users target."
        : "The proposed default is 100% for users not matched by a rule; targeting rules may still exclude other users.",
    );
  }
  if (before.rules.rules.length || after.rules.rules.length) {
    reasons.push(
      `The largest proposed saved serve is ${savedTarget}%; this is a branch cap, not a measurement of actual audience size.`,
    );
  }
  if (!canRamp && after.enabled) {
    reasons.push(
      "No effective exposure increase requiring a ramp was identified; this change is a reduction, a no-op, or has only zero serves.",
    );
  }

  let recentOther = 0;
  let recentUnknown = 0;
  for (const change of input.recentChanges) {
    const age = now - Date.parse(change.createdAt);
    // Include exactly 15 minutes ago and now; never count future timestamps.
    if (!Number.isFinite(age) || age < 0 || age > recentWindow) continue;
    if (!change.actorId?.trim()) recentUnknown += 1;
    else if (change.actorId !== input.actorId) recentOther += 1;
  }
  if (recentOther)
    reasons.push(
      `${recentOther} recent change(s) by a different actor within the last 15 minutes.`,
    );
  if (recentUnknown)
    reasons.push(
      `${recentUnknown} recent change(s) with an unknown actor within the last 15 minutes; these cannot be attributed to the current user.`,
    );

  // Conservative policy, applied only to effective expansion:
  // MEDIUM: >10 points on any branch, any production/sensitive/recent-editor
  // context, a newly full serve, or a structural change we cannot prove narrows.
  // HIGH: >=50 points anywhere, or production with >=25 points, sensitive tags,
  // a newly full serve, or structural uncertainty. In particular prod payments
  // 0->100 (including disabled activation) can never fall below HIGH.
  // Removal, addition, changed conditions and reordering are deliberately not
  // claimed safe by comparing maxima; ordered rule cohorts are not available.
  let riskLevel: RiskLevel = "LOW";
  if (canRamp) {
    if (
      jump > 10 ||
      production ||
      sensitive.length ||
      recentOther ||
      recentUnknown ||
      reachesFullServe ||
      structural
    ) {
      riskLevel = "MEDIUM";
    }
    if (
      jump >= 50 ||
      (production && (jump >= 25 || sensitive.length > 0 || reachesFullServe || structural))
    ) {
      riskLevel = "HIGH";
    }
    missingSafeguards.push(
      "Confirm error-rate and latency thresholds and a rollback owner; these safeguards are not supplied in the assessment input.",
    );
    if (structural)
      missingSafeguards.push(
        "Review targeting cohorts and rule fallthrough before advancing; audience size cannot be verified from this input.",
      );
    if (sensitive.length)
      missingSafeguards.push(
        "Confirm domain-specific success metrics for the sensitive flag before advancing.",
      );
    if (recentOther || recentUnknown)
      missingSafeguards.push("Coordinate with recent or unidentified editors before advancing.");
  }

  return {
    riskLevel,
    reasons: cleanList(reasons),
    missingSafeguards: cleanList(missingSafeguards),
    canRamp,
    // A shared cap may temporarily reduce an unchanged high-percentage branch.
    // Use the least starting percentage among increasing branches, not their
    // maximum. Structural changes have unknown cohorts, so start their cap at 0.
    start:
      structural || !before.enabled ? 0 : Math.min(...increases.map(({ from }) => from), target),
    target,
  };
}

function deterministicPlan(facts: Facts, riskLevel: RiskLevel): Plan {
  if (!facts.canRamp) return [];
  const limits = rampLimits[riskLevel];
  const plan: Plan = [];
  let percent = Math.min(facts.target, facts.start + limits.first);
  while (true) {
    plan.push({
      step: plan.length + 1,
      rolloutPercent: percent,
      hold: limits.hold,
      watch:
        "Check error rate, latency and relevant success metrics against agreed thresholds; stop or roll back on regression.",
    });
    if (percent === facts.target) return plan;
    percent = Math.min(facts.target, percent + limits.next);
  }
}

function assessmentFrom(facts: Facts, riskLevel = facts.riskLevel): RolloutRiskOutput {
  return rolloutRiskOutputSchema.parse({
    riskLevel,
    reasons: facts.reasons,
    saferPlan: deterministicPlan(facts, riskLevel),
    missingSafeguards: facts.missingSafeguards,
  });
}

/** Pure, contract-validated assessment. Pass epoch milliseconds for reproducible recency checks. */
export function deterministicRisk(input: RolloutRiskInput, now = Date.now()): RolloutRiskOutput {
  return assessmentFrom(inspect(rolloutRiskInputSchema.parse(input), now));
}

function safeModelPlan(plan: Plan, facts: Facts, riskLevel: RiskLevel): boolean {
  if (!facts.canRamp || plan.length === 0) return false;
  const limits = rampLimits[riskLevel];
  let previous = facts.start;
  return plan.every((step, index) => {
    const limit = index === 0 ? limits.first : limits.next;
    const safe =
      step.step === index + 1 &&
      step.rolloutPercent > 0 &&
      step.rolloutPercent > previous &&
      step.rolloutPercent <= facts.target &&
      step.rolloutPercent - previous <= limit &&
      step.hold.length > 0 &&
      step.watch.length > 0;
    previous = step.rolloutPercent;
    return safe;
  });
}

/** Model output is advisory: it cannot lower any floor or bypass bounded caps. */
export function enforceRiskFloor(
  input: RolloutRiskInput,
  output: RolloutRiskOutput,
  now = Date.now(),
): RolloutRiskOutput {
  const facts = inspect(rolloutRiskInputSchema.parse(input), now);
  const parsed = rolloutRiskOutputSchema.safeParse(output);
  // Discard downgrade prose as well as its rating: a factual HIGH assessment
  // must not be accompanied by model instructions to skip its safeguards.
  if (!parsed.success || rank[parsed.data.riskLevel] < rank[facts.riskLevel]) {
    return assessmentFrom(facts);
  }
  const model = parsed.data;
  const riskLevel = model.riskLevel;
  const candidate = model.saferPlan.map((step) => ({
    ...step,
    hold: cleanText(step.hold),
    watch: cleanText(step.watch),
  }));
  // A safe prefix is allowed; it need not promise automatic advancement to the
  // final target. Empty, descending, zero, over-target, skipped-number or overly
  // aggressive plans fall back in their entirety, rather than being repaired.
  return rolloutRiskOutputSchema.parse({
    riskLevel,
    reasons: cleanList([...facts.reasons, ...model.reasons]),
    saferPlan: safeModelPlan(candidate, facts, riskLevel)
      ? candidate
      : deterministicPlan(facts, riskLevel),
    missingSafeguards: cleanList([...facts.missingSafeguards, ...model.missingSafeguards]),
  });
}

/** Apply only the first validated cap, never the last step or a model-supplied rule set. */
export function applyFirstStep(
  input: RolloutRiskInput,
  assessment: RolloutRiskOutput,
): TargetingSnapshot {
  const validated = rolloutRiskInputSchema.parse(input);
  const safe = enforceRiskFloor(validated, assessment);
  const first = safe.saferPlan[0];
  // Parsing clones the snapshot. Disabled changes, pure reductions and no-ops
  // retain the requested state, regardless of an injected model ramp.
  if (!first) return validated.after;
  const after = validated.after;
  const rolloutPercent = Math.min(after.rolloutPercent, first.rolloutPercent);
  return targetingSnapshotSchema.parse({
    ...after,
    rolloutPercent,
    rules: {
      ...after.rules,
      defaultServe: { ...after.rules.defaultServe, rolloutPercent },
      rules: after.rules.rules.map((rule) => ({
        ...rule,
        serve: {
          ...rule.serve,
          rolloutPercent: Math.min(rule.serve.rolloutPercent, first.rolloutPercent),
        },
      })),
    },
  });
}
