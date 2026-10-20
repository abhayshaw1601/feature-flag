// Structural equivalents of the shared contracts; no runtime contract dependency.
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type FlagType = "RELEASE" | "OPS" | "EXPERIMENT" | "PERMISSION";
export type RuleOperator =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "greater_than"
  | "less_than";

export interface Condition {
  attribute: string;
  operator: RuleOperator;
  values: JsonScalar[];
}

export interface Serve {
  rolloutPercent: number;
}

export interface Rule {
  id: string;
  description: string;
  conditions: Condition[];
  serve: Serve;
}

export interface RuleSet {
  rules: Rule[];
  defaultServe: Serve;
}

export interface EvaluationUser {
  id: string;
  attributes: Record<string, JsonScalar>;
}

export interface ServerFlagConfig {
  key: string;
  type: FlagType;
  enabled: boolean;
  rules: RuleSet;
  onValue: JsonValue;
  offValue: JsonValue;
  version: number;
}

export type EvaluationReason =
  | "disabled"
  | "rule_match"
  | "default"
  | "invalid_config"
  | "invalid_context";

export interface EvaluationResult {
  value: JsonValue;
  variation: "on" | "off" | "fallback";
  reason: EvaluationReason;
  ruleId?: string;
}
