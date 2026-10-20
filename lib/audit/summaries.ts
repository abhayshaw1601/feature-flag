import { ruleSetSchema, type RuleSet } from "@flagforge/contracts";
import { redactAiLog, sanitizeAiText } from "../ai/sanitize";
import type { AuditRow } from "./types";

/** Presentation only: never apply this to snapshots or identifiers used for comparisons. */
export function sanitizeAuditLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = sanitizeAiText(value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Labels are bounded, not truncated into a different name. Payload fields are never labels.
  if (!text || text.length > 160) return null;
  const redacted = redactAiLog(text) as string;
  if (
    redacted !== text ||
    /(?:secret|token|password|authorization|cookie|api[ _-]?key|private[ _-]?key)\s*[:=]|-----BEGIN|\b(?:sk|rk)-[a-z0-9]{16,}/i.test(
      text,
    )
  )
    return null;
  return text;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function rulesOf(state: Record<string, unknown> | undefined): RuleSet | undefined {
  if (!state || !ruleSetSchema.safeParse(state.rules).success) return undefined;
  // Validation may trim descriptions/attributes. Compare the original factual values instead.
  const rules = state.rules as RuleSet;
  if (new Set(rules.rules.map((rule) => rule.id)).size !== rules.rules.length) return undefined;
  return rules;
}

function defaultPercent(state: Record<string, unknown> | undefined): number | undefined {
  if (!state) return undefined;
  const direct = percent(state.rolloutPercent);
  if (Object.hasOwn(state, "rolloutPercent") && direct === undefined) return undefined;
  if (Object.hasOwn(state, "rules")) {
    const rules = rulesOf(state);
    if (!rules) return undefined;
    const fallback = rules.defaultServe.rolloutPercent;
    // Contradictory snapshots are insufficient evidence of either percentage.
    if (direct !== undefined && direct !== fallback) return undefined;
    return fallback;
  }
  return direct;
}

function conditionsOf(rule: RuleSet["rules"][number]) {
  return rule.conditions.map(({ attribute, operator, values }) => ({
    attribute,
    operator,
    values,
  }));
}

function targeting(rules: RuleSet): unknown {
  return rules.rules.map((rule) => ({
    id: rule.id,
    conditions: conditionsOf(rule),
    rolloutPercent: rule.serve.rolloutPercent,
  }));
}

function changes(row: AuditRow) {
  const before = record(row.before);
  const after = record(row.after);
  const beforeRules = rulesOf(before);
  const afterRules = rulesOf(after);
  return {
    before,
    after,
    beforeRules,
    afterRules,
    from: defaultPercent(before),
    to: defaultPercent(after),
    enabledChanged:
      typeof before?.enabled === "boolean" &&
      typeof after?.enabled === "boolean" &&
      before.enabled !== after.enabled,
    targetingChanged:
      !!beforeRules &&
      !!afterRules &&
      JSON.stringify(targeting(beforeRules)) !== JSON.stringify(targeting(afterRules)),
  };
}

function isProduction(row: AuditRow): boolean {
  return [row.environmentKey, row.environmentName].some((label) => {
    if (!label) return false;
    const normalized = label.normalize("NFKC").toLowerCase();
    if (
      /(?:^|[^a-z0-9])(?:non|not|no|pre)[\s._/-]*(?:production|prod|prd|live)(?:$|[^a-z0-9])/.test(
        normalized,
      )
    )
      return false;
    return /(?:^|[^a-z0-9])(?:production|prod|prd|live)(?:$|[^a-z0-9])/.test(normalized);
  });
}

const updateActions = new Set([
  "FLAG_UPDATED",
  "ENVIRONMENT_UPDATED",
  "AUTO_RAMP",
  "AUTO_ROLLBACK",
]);

/** A deterministic review hint, not a prediction of traffic or an AI judgement. */
export function classifyAuditRisk(row: AuditRow): boolean {
  const production = isProduction(row);
  if (["FLAG_ARCHIVED", "SDK_KEY_REVOKED", "AUTO_ROLLBACK"].includes(row.action) && production)
    return true;
  if (!updateActions.has(row.action)) return false;
  const facts = changes(row);
  if (production && facts.enabledChanged && facts.after?.enabled === true) return true;
  if (facts.from !== undefined && facts.to !== undefined && facts.to - facts.from >= 25)
    return true;
  if (production && facts.targetingChanged) return true;
  // Only compare the same targeted branch with the same audience; never treat it as default.
  return !!facts.afterRules?.rules.some((rule) => {
    const previous = facts.beforeRules?.rules.find((candidate) => candidate.id === rule.id);
    return (
      !!previous &&
      JSON.stringify(conditionsOf(previous)) === JSON.stringify(conditionsOf(rule)) &&
      rule.serve.rolloutPercent - previous.serve.rolloutPercent >= 25
    );
  });
}

/** Two equivalent, bounded sentences grounded only in this row and validated known fields. */
export function summaryCandidates(row: AuditRow): string[] {
  const actor =
    sanitizeAuditLabel(row.actor?.name) ?? sanitizeAuditLabel(row.actorName) ?? "An unknown actor";
  const label = sanitizeAuditLabel(row.flagKey);
  // Do not rename a flag by stripping characters from its identifier.
  const flag = label && label === row.flagKey ? label : "an unidentified flag";
  const environment =
    sanitizeAuditLabel(row.environmentName) ?? sanitizeAuditLabel(row.environmentKey);
  const scope = environment
    ? ` in ${environment}`
    : row.environmentId !== null
      ? " in an unidentified environment"
      : "";
  const lifecycle: Record<string, [string, string]> = {
    FLAG_CREATED: ["created", "creation"],
    FLAG_ARCHIVED: ["archived", "archival"],
    FLAG_RESTORED: ["restored", "restoration"],
    SDK_KEY_CREATED: ["created", "creation"],
    SDK_KEY_REVOKED: ["revoked", "revocation"],
  };
  const action = Object.hasOwn(lifecycle, row.action) ? lifecycle[row.action] : undefined;
  if (action) {
    const subject = row.action.startsWith("SDK_KEY_") ? "an SDK key" : flag;
    return [
      `${actor} ${action[0]} ${subject}${scope}.`,
      `The audit log records ${action[1]} of ${subject}${scope} by ${actor}.`,
    ];
  }
  if (updateActions.has(row.action)) {
    const subject =
      row.action === "ENVIRONMENT_UPDATED" && row.flagId === null && !label
        ? "the environment configuration"
        : flag;
    const facts = changes(row);
    const details: string[] = [];
    if (facts.enabledChanged)
      details.push(facts.after?.enabled ? "disabled to enabled" : "enabled to disabled");
    if (facts.from !== undefined && facts.to !== undefined && facts.from !== facts.to)
      details.push(
        `default rollout ${facts.to > facts.from ? "increased" : "decreased"} from ${facts.from}% to ${facts.to}%`,
      );
    if (facts.targetingChanged) details.push("targeting rules changed");
    if (details.length)
      return [
        `${actor} updated ${subject}${scope}: ${details.join("; ")}.`,
        `${actor} changed ${subject}${scope} (${details.join("; ")}).`,
      ];
    return [
      `${actor} updated ${subject}${scope}; comparable change details are unavailable.`,
      `An update to ${subject}${scope} by ${actor} was recorded without comparable change details.`,
    ];
  }
  return [
    `An audit event${row.flagId !== null ? ` for ${flag}` : ""}${scope} was recorded with actor ${actor}; change details are unavailable.`,
    `The audit log records an event${row.flagId !== null ? ` for ${flag}` : ""}${scope} with actor ${actor}; no supported change details are available.`,
  ];
}

/** Preserve raw snapshots/identifiers; an ungrounded cached sentence loses its AI provenance. */
export function normalizeAuditRow(row: AuditRow): AuditRow {
  const candidates = summaryCandidates(row);
  const valid = candidates.includes(row.summary);
  return {
    ...row,
    summary: valid ? row.summary : candidates[0],
    summarySource: valid ? row.summarySource : "fallback",
    summaryModel: valid ? sanitizeAuditLabel(row.summaryModel) : null,
    risky: classifyAuditRisk(row),
  };
}
