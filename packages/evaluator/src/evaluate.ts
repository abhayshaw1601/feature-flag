import { bucket } from "./hash.js";
import { isCondition, isFlag, isScalar, isUser, ownData } from "./validation.js";
import type {
  Condition,
  EvaluationReason,
  EvaluationResult,
  EvaluationUser,
  JsonValue,
  ServerFlagConfig,
} from "./types.js";

function matchValidated(condition: Condition, user: EvaluationUser): boolean {
  const actual = ownData(user.attributes, condition.attribute);
  // The presence check precedes negation: absent is never "not equal".
  if (!isScalar(actual)) return false;
  const values = condition.values;
  switch (condition.operator) {
    case "equals":
    case "in":
      return values.some((expected) => actual === expected);
    case "not_equals":
    case "not_in":
      return values.every((expected) => actual !== expected);
    case "contains":
      return (
        typeof actual === "string" &&
        values.some((expected) => typeof expected === "string" && actual.includes(expected))
      );
    case "starts_with":
      return (
        typeof actual === "string" &&
        values.some((expected) => typeof expected === "string" && actual.startsWith(expected))
      );
    case "greater_than":
      return (
        typeof actual === "number" &&
        values.some((expected) => typeof expected === "number" && actual > expected)
      );
    case "less_than":
      return (
        typeof actual === "number" &&
        values.some((expected) => typeof expected === "number" && actual < expected)
      );
  }
}

/** Invalid conditions/contexts and missing attributes never match. */
export function matchesCondition(condition: Condition, user: EvaluationUser): boolean {
  try {
    return isCondition(condition) && isUser(user) && matchValidated(condition, user);
  } catch {
    return false;
  }
}

/** Evaluate one config without I/O, mutation, caching, or truthiness conversions. */
export function evaluateDetailed(
  flag: ServerFlagConfig | null | undefined,
  user: EvaluationUser | null | undefined,
  fallback: JsonValue,
): EvaluationResult {
  let failureReason: EvaluationReason = "invalid_config";
  try {
    // Validate the entire config, including unselected values/rules, on every call.
    if (!isFlag(flag)) return { value: fallback, variation: "fallback", reason: failureReason };
    if (!flag.enabled) return { value: flag.offValue, variation: "off", reason: "disabled" };

    failureReason = "invalid_context";
    if (!isUser(user)) return { value: fallback, variation: "fallback", reason: failureReason };

    failureReason = "invalid_config";
    let rolloutPercent = flag.rules.defaultServe.rolloutPercent;
    let ruleId: string | undefined;
    for (const rule of flag.rules.rules) {
      if (rule.conditions.every((condition) => matchValidated(condition, user))) {
        rolloutPercent = rule.serve.rolloutPercent;
        ruleId = rule.id;
        break;
      }
    }

    const on = bucket(flag.key, user.id) < rolloutPercent * 100;
    return {
      value: on ? flag.onValue : flag.offValue,
      variation: on ? "on" : "off",
      reason: ruleId === undefined ? "default" : "rule_match",
      ...(ruleId === undefined ? {} : { ruleId }),
    };
  } catch {
    // Also fail closed for throwing proxies and cyclic/excessively deep non-JSON input.
    return { value: fallback, variation: "fallback", reason: failureReason };
  }
}

export function evaluateFlag(
  flag: ServerFlagConfig | null | undefined,
  user: EvaluationUser | null | undefined,
  fallback: JsonValue,
): JsonValue {
  return evaluateDetailed(flag, user, fallback).value;
}
