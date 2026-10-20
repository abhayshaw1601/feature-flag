import type { FlagSummary, JsonValue } from "@flagforge/contracts";
import type { ScannedReference } from "./scanner";

export type StaleCandidate = {
  flagId: string;
  flagKey: string;
  flagName: string;
  reason: "ON_EVERYWHERE" | "OFF_EVERYWHERE";
  daysStale: number;
  referenceCount: number;
  references: ScannedReference[];
};

const dayMilliseconds = 86_400_000;

function threshold(value: number | undefined, fallback: number, name: string): number {
  const days = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return days;
}

// Contracts use UTC ISO datetimes. Date.parse alone silently normalizes bad dates
// such as February 30, so check the calendar/time portion after parsing as well.
function timestamp(value: string, now: number): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now) return;
  if (new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) return;
  return parsed;
}

/** Structural JSON equality: object property order is immaterial, array order is not. */
function sameValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

/**
 * Pure candidate detection over validated FlagSummary snapshots, never a removal
 * authorization. Empty/duplicate expected environments or incomplete, duplicate,
 * or unexpected configs fail closed. Invalid options throw; invalid/future flag
 * dates exclude that flag. Both rollout representations must guarantee ON.
 * Only the served value must agree across environments; an unreachable opposite
 * value does not affect the replacement. OFF bypasses targeting entirely.
 *
 * Age is whole elapsed 24-hour days since the latest config edit or flag creation.
 * Metadata updatedAt is validated but does not reset configuration age. Without
 * audit history this is only a conservative bound, assuming updatedAt changes on
 * every config edit; snapshots cannot prove historical continuity. Scanner misses,
 * incomplete caller-supplied environment inventories and SDK fallback behavior
 * still need separate review before removal.
 */
export function findStaleCandidates(
  flags: readonly FlagSummary[],
  references: readonly ScannedReference[],
  options: {
    now: Date;
    environmentKeys: readonly string[];
    onDays?: number;
    offDays?: number;
  },
): StaleCandidate[] {
  const onDays = threshold(options.onDays, 30, "onDays");
  const offDays = threshold(options.offDays, 60, "offDays");
  const now = options.now.getTime();
  if (!Number.isFinite(now)) throw new RangeError("now must be a valid Date");

  const expected = new Set(options.environmentKeys);
  if (
    expected.size === 0 ||
    expected.size !== options.environmentKeys.length ||
    options.environmentKeys.some((key) => !/^[a-z0-9-]+$/.test(key))
  ) {
    return [];
  }

  const byKey = new Map<string, ScannedReference[]>();
  for (const reference of references) {
    const existing = byKey.get(reference.flagKey);
    if (existing) existing.push(reference);
    else byKey.set(reference.flagKey, [reference]);
  }

  const candidates: StaleCandidate[] = [];
  for (const flag of flags) {
    const flagReferences = byKey.get(flag.key);
    if (flag.archivedAt !== null || !flagReferences?.length) continue;
    if (flag.environments.length !== expected.size) continue;
    const seen = new Set<string>();
    if (
      flag.environments.some((environment) => {
        if (!expected.has(environment.environmentKey) || seen.has(environment.environmentKey)) {
          return true;
        }
        seen.add(environment.environmentKey);
        return false;
      })
    ) {
      continue;
    }
    // Different keys sharing an environment identity are not independent coverage.
    if (
      new Set(flag.environments.map((environment) => environment.environmentId)).size !==
      expected.size
    ) {
      continue;
    }

    const created = timestamp(flag.createdAt, now);
    if (created === undefined || timestamp(flag.updatedAt, now) === undefined) continue;
    const changes = flag.environments.map((environment) => timestamp(environment.updatedAt, now));
    if (changes.some((change) => change === undefined)) continue;
    const latest = Math.max(created, ...(changes as number[]));
    const daysStale = Math.floor((now - latest) / dayMilliseconds);

    const on = flag.environments.every(
      (environment) =>
        environment.enabled === true &&
        environment.rolloutPercent === 100 &&
        environment.rules.defaultServe.rolloutPercent === 100 &&
        environment.rules.rules.every((rule) => rule.serve.rolloutPercent === 100),
    );
    const off = flag.environments.every((environment) => environment.enabled === false);
    if ((!on && !off) || daysStale < (on ? onDays : offDays)) continue;

    const valueKey = on ? "onValue" : "offValue";
    const value = flag.environments[0][valueKey];
    if (!flag.environments.every((environment) => sameValue(value, environment[valueKey]))) {
      continue;
    }

    candidates.push({
      flagId: flag.id,
      flagKey: flag.key,
      flagName: flag.name,
      reason: on ? "ON_EVERYWHERE" : "OFF_EVERYWHERE",
      daysStale,
      referenceCount: flagReferences.length,
      references: [...flagReferences],
    });
  }
  return candidates;
}
