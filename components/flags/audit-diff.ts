import type { JsonValue } from "@flagforge/contracts";

export type AuditFieldChange = {
  field: string;
  before: JsonValue | undefined;
  after: JsonValue | undefined;
};

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function equalValues(before: JsonValue | undefined, after: JsonValue | undefined): boolean {
  if (before === after) return true;
  if (Array.isArray(before) && Array.isArray(after)) {
    return (
      before.length === after.length &&
      before.every((value, index) => equalValues(value, after[index]))
    );
  }
  if (isObject(before) && isObject(after)) {
    const keys = Object.keys(before);
    return (
      keys.length === Object.keys(after).length &&
      keys.every((key) => Object.hasOwn(after, key) && equalValues(before[key], after[key]))
    );
  }
  return false;
}

export function auditFieldChanges(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path = "",
): AuditFieldChange[] {
  if (equalValues(before, after)) return [];
  if (
    (isObject(before) || before == null) &&
    (isObject(after) || after == null) &&
    (isObject(before) || isObject(after))
  ) {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    if (keys.size)
      return [...keys].flatMap((key) =>
        auditFieldChanges(before?.[key], after?.[key], path ? `${path}.${key}` : key),
      );
  }
  return [{ field: path || "Value", before, after }];
}

export function readableField(field: string) {
  return field
    .split(".")
    .map((part) => {
      const normalized = part === part.toUpperCase() ? part.toLowerCase() : part;
      const words = normalized.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" / ");
}

export function readableValue(value: JsonValue | undefined): string {
  if (value === undefined) return "Not present";
  if (value === null) return "None";
  if (value === "") return 'Empty string ("")';
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
