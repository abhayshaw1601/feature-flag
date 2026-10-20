export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface EvaluationUser {
  id: string;
  attributes: Record<string, JsonScalar>;
}

export type FlagType = "RELEASE" | "OPS" | "EXPERIMENT" | "PERMISSION";
export type KeyType = "SERVER" | "CLIENT";
export type Variation = "on" | "off" | "resolved";

export interface ServerFlagConfig {
  key: string;
  type: FlagType;
  enabled: boolean;
  rules: {
    rules: {
      id: string;
      description: string;
      conditions: {
        attribute: string;
        operator:
          | "equals"
          | "not_equals"
          | "in"
          | "not_in"
          | "contains"
          | "starts_with"
          | "greater_than"
          | "less_than";
        values: JsonScalar[];
      }[];
      serve: { rolloutPercent: number };
    }[];
    defaultServe: { rolloutPercent: number };
  };
  offValue: JsonValue;
  onValue: JsonValue;
  version: number;
}

export interface ResolvedClientFlag {
  key: string;
  type: FlagType;
  value: JsonValue;
  version: number;
}

/** Snapshots passed to onChange are recursively frozen. */
export interface ConfigSnapshot {
  readonly environmentKey: string;
  readonly version: number;
  readonly flags: Readonly<Record<string, ServerFlagConfig | ResolvedClientFlag>>;
}

export interface FlagForgeOptions {
  /** Server origin, optionally including a deployment path prefix. */
  baseUrl: string;
  sdkKey: string;
  /** Explicit key type; defaults to SERVER regardless of key prefix. */
  keyType?: KeyType;
  /** Default evaluation user. Required and fixed for CLIENT keys. */
  user?: EvaluationUser;
  fetch?: typeof globalThis.fetch;
  /** Positive interval; defaults to 30,000 ms. Polling also repairs missed stream updates. */
  pollIntervalMs?: number;
  /** Positive interval; defaults to 10,000 ms. */
  flushIntervalMs?: number;
  /** Defaults to true. Uses authenticated fetch, never EventSource. */
  streaming?: boolean;
  /** Positive timeout, capped at 30,000 ms; defaults to 5,000 ms. Also bounds close(). */
  requestTimeoutMs?: number;
}

export interface FlagForgeClient {
  isEnabled(key: string, user: EvaluationUser | undefined, fallback: boolean): boolean;
  getValue(key: string, user: EvaluationUser | undefined, fallback: JsonValue): JsonValue;
  /** Listens for subsequent changed snapshots, including versions and flag removals. */
  onChange(callback: (snapshot: ConfigSnapshot) => void): () => void;
  /** Records a metric for the current variation; unavailable evaluations are ignored. */
  track(metric: string, value: number, flagKey: string, user?: EvaluationUser): void;
  /** Coalesces concurrent requests; errors retain the last valid snapshot. */
  refresh(): Promise<void>;
  /** Sends queued events in batches of at most 500; failed batches remain queued. */
  flush(): Promise<void>;
  /** Idempotent bounded shutdown. Evaluation after close returns the supplied fallback. */
  close(): Promise<void>;
}

export type SdkEvent =
  | {
      kind: "exposure";
      flagKey: string;
      variation: Variation;
      userHash: string;
      occurredAt: string;
    }
  | {
      kind: "metric";
      flagKey: string;
      variation: Variation;
      metric: string;
      value: number;
      occurredAt: string;
    };
