import type { Environment, SdkOptions } from "./environment";
import { SAMPLE_ATTRIBUTES, type Evaluation } from "./evaluation";

type User = { id: string; attributes: Record<string, string> };

// This narrow seam also lets the offline smoke test exercise startup and cache behavior.
// The server adapter below is checked against the real SDK export by TypeScript.
export interface EvaluationClient {
  isEnabled(key: string, user: User, fallback: boolean): boolean;
  getValue(key: string, user: User, fallback: { missing: true }): unknown;
  onChange(callback: () => void): unknown;
  close(): void | Promise<void>;
}

interface StoreOptions {
  environment: Environment;
  init(options: SdkOptions): Promise<EvaluationClient>;
  now?: () => number;
}

export function createEvaluationStore({ environment, init, now = Date.now }: StoreOptions) {
  let client: EvaluationClient | undefined;
  let pending = false;
  let disposed = false;
  let failed = false;
  let retryAt = 0;
  let cacheUpdatedAt: string | null = null;
  const missing = { missing: true } as const;

  function start() {
    if (!environment.ok || pending || client || disposed || now() < retryAt) return;
    pending = true;
    failed = false;

    // Do not await network initialization in a page render or route handler.
    void Promise.resolve()
      .then(() => init(environment.options))
      .then((next) => {
        if (disposed) {
          void Promise.resolve(next.close()).catch(() => undefined);
          return;
        }
        client = next;
        next.onChange(() => {
          cacheUpdatedAt = new Date(now()).toISOString();
        });
      })
      .catch(() => {
        // Never serialize or log SDK errors: they may contain headers or URLs.
        if (client) void Promise.resolve(client.close()).catch(() => undefined);
        client = undefined;
        failed = true;
        retryAt = now() + 30_000;
      })
      .finally(() => {
        pending = false;
      });
  }

  return {
    evaluate(userId: string): Evaluation {
      const fallback: Evaluation = {
        userId,
        enabled: false,
        source: "default",
        status: "initializing",
        message: "Starting the server SDK. The classic checkout is the safe default.",
        cacheUpdatedAt: null,
      };
      if (!environment.ok) {
        return { ...fallback, status: "configuration-error", message: environment.message };
      }

      start();
      if (!client) {
        return failed
          ? {
              ...fallback,
              status: "sdk-error",
              message:
                "The server SDK could not start. It will retry in 30 seconds; check the server environment.",
            }
          : fallback;
      }

      try {
        const user = { id: userId, attributes: { ...SAMPLE_ATTRIBUTES } };
        const enabled = client.isEnabled(environment.flagKey, user, false);
        // The value is used only to distinguish an absent flag from a real off value.
        // An object sentinel also treats legitimate null/false values as cached data.
        if (client.getValue(environment.flagKey, user, missing) === missing) {
          return {
            ...fallback,
            status: "waiting",
            message:
              "No cached flag yet. Check the flag name, server key's environment, and FlagForge availability. The SDK keeps retrying.",
          };
        }
        cacheUpdatedAt ??= new Date(now()).toISOString();
        return {
          userId,
          enabled,
          source: "cache",
          status: "ready",
          message: null,
          cacheUpdatedAt,
        };
      } catch {
        return {
          ...fallback,
          status: "sdk-error",
          message:
            "The cached flag could not be evaluated. Using the safe off default; retry or check the server configuration.",
        };
      }
    },
    close() {
      disposed = true;
      const closing = client?.close();
      client = undefined;
      return closing;
    },
  };
}
