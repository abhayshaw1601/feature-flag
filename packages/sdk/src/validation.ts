import type {
  ConfigSnapshot,
  EvaluationUser,
  JsonScalar,
  JsonValue,
  KeyType,
  ResolvedClientFlag,
  ServerFlagConfig,
} from "./types.js";

const operators = new Set([
  "equals",
  "not_equals",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "greater_than",
  "less_than",
]);
const flagTypes = new Set(["RELEASE", "OPS", "EXPERIMENT", "PERMISSION"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

// Depth and node limits also bound canonicalization, cloning, and freezing of untrusted JSON.
function isJson(value: unknown, depth = 0, budget = { left: 100_000 }): value is JsonValue {
  if (--budget.left < 0 || depth > 64) return false;
  if (isScalar(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1, budget));
  return isRecord(value) && Object.values(value).every((item) => isJson(item, depth + 1, budget));
}

export function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isServe(value: unknown): boolean {
  return isRecord(value) && isVersion(value.rolloutPercent) && value.rolloutPercent <= 100;
}

function isRules(value: unknown): boolean {
  if (!isRecord(value) || !isServe(value.defaultServe) || !Array.isArray(value.rules)) return false;
  return (
    value.rules.length <= 50 &&
    value.rules.every(
      (rule) =>
        isRecord(rule) &&
        typeof rule.id === "string" &&
        /^rule_[a-z0-9_-]+$/.test(rule.id) &&
        typeof rule.description === "string" &&
        rule.description.trim().length > 0 &&
        rule.description.trim().length <= 240 &&
        isServe(rule.serve) &&
        Array.isArray(rule.conditions) &&
        rule.conditions.length > 0 &&
        rule.conditions.length <= 20 &&
        rule.conditions.every(
          (condition) =>
            isRecord(condition) &&
            typeof condition.attribute === "string" &&
            condition.attribute.trim().length > 0 &&
            condition.attribute.trim().length <= 64 &&
            typeof condition.operator === "string" &&
            operators.has(condition.operator) &&
            Array.isArray(condition.values) &&
            condition.values.length > 0 &&
            condition.values.length <= 50 &&
            condition.values.every(isScalar),
        ),
    )
  );
}

export function isUser(value: unknown): value is EvaluationUser {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isRecord(value.attributes) &&
    Object.values(value.attributes).every(isScalar)
  );
}

/** Object key ordering has no effect on snapshot or user-context equality. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Accept an entire valid response or leave the existing cache untouched. No Zod runtime. */
export function parseConfig(payload: unknown, keyType: KeyType): ConfigSnapshot | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return;
  const data = payload.data;
  if (
    typeof data.environmentKey !== "string" ||
    data.environmentKey.length === 0 ||
    !isVersion(data.version) ||
    !isRecord(data.flags)
  ) {
    return;
  }
  const flags: Record<string, ServerFlagConfig | ResolvedClientFlag> = Object.create(null);
  for (const [key, flag] of Object.entries(data.flags)) {
    if (
      !isRecord(flag) ||
      key.length === 0 ||
      flag.key !== key ||
      typeof flag.type !== "string" ||
      !flagTypes.has(flag.type) ||
      !isVersion(flag.version)
    ) {
      return;
    }
    if (keyType === "SERVER") {
      if (
        typeof flag.enabled !== "boolean" ||
        !isRules(flag.rules) ||
        !isJson(flag.offValue) ||
        !isJson(flag.onValue) ||
        Object.hasOwn(flag, "value")
      ) {
        return;
      }
      flags[key] = clone({
        key,
        type: flag.type,
        enabled: flag.enabled,
        rules: flag.rules,
        offValue: flag.offValue,
        onValue: flag.onValue,
        version: flag.version,
      }) as ServerFlagConfig;
    } else {
      if (
        !isJson(flag.value) ||
        ["enabled", "rules", "onValue", "offValue"].some((field) => Object.hasOwn(flag, field))
      ) {
        return;
      }
      flags[key] = clone({
        key,
        type: flag.type,
        value: flag.value,
        version: flag.version,
      }) as ResolvedClientFlag;
    }
  }
  return freeze({ environmentKey: data.environmentKey, version: data.version, flags });
}
