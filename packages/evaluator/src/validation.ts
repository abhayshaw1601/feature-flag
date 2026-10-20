import type { Condition, EvaluationUser, JsonScalar, ServerFlagConfig } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Never resolve inherited properties or invoke accessors. */
export function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

export function isScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (isScalar(value)) return true;
  if (typeof value !== "object" || value === null || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (!array) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  ancestors.add(value);
  let valid = true;
  if (array) {
    for (let i = 0; i < value.length; i += 1) {
      if (!isJson(ownData(value, String(i)), ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    for (const key of Object.keys(value)) {
      if (!isJson(ownData(value, key), ancestors)) {
        valid = false;
        break;
      }
    }
  }
  ancestors.delete(value);
  return valid;
}

function isArrayOf(
  value: unknown,
  min: number,
  max: number,
  check: (item: unknown) => boolean,
): boolean {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!check(ownData(value, String(i)))) return false;
  }
  return true;
}

export function isCondition(value: unknown): value is Condition {
  if (!isRecord(value)) return false;
  const attribute = ownData(value, "attribute");
  const operator = ownData(value, "operator");
  return (
    typeof attribute === "string" &&
    attribute.trim().length > 0 &&
    attribute.length <= 64 &&
    (operator === "equals" ||
      operator === "not_equals" ||
      operator === "in" ||
      operator === "not_in" ||
      operator === "contains" ||
      operator === "starts_with" ||
      operator === "greater_than" ||
      operator === "less_than") &&
    isArrayOf(ownData(value, "values"), 1, 50, isScalar)
  );
}

function isServe(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const percent = ownData(value, "rolloutPercent");
  return typeof percent === "number" && Number.isInteger(percent) && percent >= 0 && percent <= 100;
}

function isRule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const id = ownData(value, "id");
  const description = ownData(value, "description");
  return (
    typeof id === "string" &&
    /^rule_[a-z0-9_-]+$/.test(id) &&
    typeof description === "string" &&
    description.trim().length > 0 &&
    description.length <= 240 &&
    isArrayOf(ownData(value, "conditions"), 1, 20, isCondition) &&
    isServe(ownData(value, "serve"))
  );
}

export function isFlag(value: unknown): value is ServerFlagConfig {
  if (!isRecord(value)) return false;
  const type = ownData(value, "type");
  const version = ownData(value, "version");
  const rules = ownData(value, "rules");
  return (
    typeof ownData(value, "key") === "string" &&
    (type === "RELEASE" || type === "OPS" || type === "EXPERIMENT" || type === "PERMISSION") &&
    typeof ownData(value, "enabled") === "boolean" &&
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 0 &&
    isJson(ownData(value, "onValue")) &&
    isJson(ownData(value, "offValue")) &&
    isRecord(rules) &&
    isServe(ownData(rules, "defaultServe")) &&
    isArrayOf(ownData(rules, "rules"), 0, 50, isRule)
  );
}

export function isUser(value: unknown): value is EvaluationUser {
  if (!isRecord(value)) return false;
  const id = ownData(value, "id");
  const attributes = ownData(value, "attributes");
  return (
    typeof id === "string" &&
    id.length > 0 &&
    isRecord(attributes) &&
    Object.keys(attributes).every((key) => isScalar(ownData(attributes, key)))
  );
}
