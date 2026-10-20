export const DEFAULT_USER_ID = "customer_1042";
export const USER_ID_MAX_LENGTH = 80;
export const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}$/;
export const SAMPLE_ATTRIBUTES = { country: "IN", plan: "pro" } as const;

export type EvaluationStatus =
  | "configuration-error"
  | "initializing"
  | "waiting"
  | "ready"
  | "sdk-error";

// Deliberately contains no SDK key, flag definitions, rules, or arbitrary flag value.
export interface Evaluation {
  userId: string;
  enabled: boolean;
  source: "default" | "cache";
  status: EvaluationStatus;
  message: string | null;
  cacheUpdatedAt: string | null;
}
