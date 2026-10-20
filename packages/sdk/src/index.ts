import { evaluateDetailed } from "../../evaluator/src/index.js";
import { SseParser } from "./sse.js";
import { canonical, clone, isRecord, isUser, isVersion, parseConfig } from "./validation.js";
import type {
  ConfigSnapshot,
  EvaluationUser,
  FlagForgeClient,
  FlagForgeOptions,
  JsonValue,
  KeyType,
  SdkEvent,
  Variation,
} from "./types.js";

export type {
  ConfigSnapshot,
  EvaluationUser,
  FlagForgeClient,
  FlagForgeOptions,
  FlagType,
  JsonScalar,
  JsonValue,
  KeyType,
  ResolvedClientFlag,
  ServerFlagConfig,
  SdkEvent,
  Variation,
} from "./types.js";

const MAX_QUEUE_SIZE = 1_000;
const MAX_BATCH_SIZE = 500;
type Timer = ReturnType<typeof setTimeout>;
type PendingEvent = Promise<SdkEvent | undefined>;
type Evaluation = { value: JsonValue; variation: Variation; user: EvaluationUser };

function interval(
  value: number | undefined,
  defaultValue: number,
  maximum = 2_147_483_647,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("SDK intervals must be positive");
  return Math.max(1, Math.min(Math.floor(value), maximum));
}

function backgroundTimer(callback: () => void, delay: number): Timer {
  const timer = setTimeout(callback, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** Still settles when an injected fetch or reader ignores AbortSignal. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("SDK request aborted"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

class Client implements FlagForgeClient {
  private readonly baseUrl: string;
  private readonly sdkKey: string;
  private readonly keyType: KeyType;
  private readonly user?: EvaluationUser;
  private readonly context?: string;
  private readonly contextFingerprint?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly pollIntervalMs: number;
  private readonly flushIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly streaming: boolean;
  private readonly listeners = new Set<(snapshot: ConfigSnapshot) => void>();
  private readonly requests = new Set<AbortController>();
  private snapshot?: ConfigSnapshot;
  private fingerprint?: string;
  private etag?: string;
  private refreshPromise?: Promise<void>;
  private flushPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private queue: PendingEvent[] = [];
  private inFlightEvents = 0;
  private closed = false;
  private pollTimer?: Timer;
  private flushTimer?: Timer;
  private reconnectTimer?: Timer;
  private streamController?: AbortController;
  private streamReader?: ReadableStreamDefaultReader<Uint8Array>;
  private streamFailures = 0;

  constructor(options: FlagForgeOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new TypeError("SDK baseUrl must be an HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("SDK baseUrl must be HTTP(S) without credentials, query, or fragment");
    }
    if (
      typeof options.sdkKey !== "string" ||
      !options.sdkKey.trim() ||
      /[\r\n]/.test(options.sdkKey)
    ) {
      throw new TypeError("SDK sdkKey is required and must be a valid header value");
    }
    this.keyType = options.keyType ?? "SERVER";
    if (this.keyType !== "SERVER" && this.keyType !== "CLIENT") {
      throw new TypeError("SDK keyType must be SERVER or CLIENT");
    }
    if (options.user !== undefined && !isUser(options.user)) {
      throw new TypeError("SDK user must have a nonempty id and scalar attributes");
    }
    if (this.keyType === "CLIENT" && !options.user) {
      throw new TypeError("CLIENT SDK keys require a user context");
    }
    this.baseUrl = url.href.replace(/\/+$/, "");
    this.sdkKey = options.sdkKey;
    this.user = options.user
      ? clone({ id: options.user.id, attributes: options.user.attributes })
      : undefined;
    if (this.keyType === "CLIENT") {
      this.context = encodeURIComponent(JSON.stringify(this.user));
      this.contextFingerprint = canonical(this.user);
    }
    this.fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.fetcher !== "function") throw new TypeError("SDK requires fetch support");
    this.pollIntervalMs = interval(options.pollIntervalMs, 30_000);
    this.flushIntervalMs = interval(options.flushIntervalMs, 10_000);
    this.requestTimeoutMs = interval(options.requestTimeoutMs, 5_000, 30_000);
    this.streaming = options.streaming ?? true;
  }

  start(): void {
    this.schedulePoll();
    this.scheduleFlush();
    if (this.streaming) void this.connectStream();
  }

  private headers(context = false): Headers {
    const headers = new Headers({ Authorization: `Bearer ${this.sdkKey}` });
    if (context && this.context) headers.set("X-FlagForge-Context", this.context);
    return headers;
  }

  private async request<T>(
    work: (signal: AbortSignal) => Promise<T>,
    timeout = this.requestTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await abortable(work(controller.signal), controller.signal);
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.refreshPromise) {
      this.refreshPromise = this.loadConfig().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async loadConfig(): Promise<void> {
    try {
      const result = await this.request(async (signal) => {
        const headers = this.headers(true);
        if (this.etag) headers.set("If-None-Match", this.etag);
        const response = await this.fetcher(`${this.baseUrl}/api/sdk/config`, {
          method: "GET",
          headers,
          signal,
          cache: "no-store",
          redirect: "error",
        });
        if (response.status === 304 || !response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return;
        }
        const snapshot = parseConfig(await response.json(), this.keyType);
        return snapshot ? { snapshot, etag: response.headers.get("ETag") ?? undefined } : undefined;
      });
      if (this.closed || !result) return;
      const fingerprint = canonical(result.snapshot);
      this.etag = result.etag;
      if (this.fingerprint === fingerprint) return;
      this.fingerprint = fingerprint;
      this.snapshot = result.snapshot;
      for (const listener of [...this.listeners]) {
        if (this.closed) break;
        if (!this.listeners.has(listener)) continue;
        try {
          listener(result.snapshot);
        } catch {
          // Consumer callbacks cannot break delivery or prevent other subscribers.
        }
      }
    } catch {
      // Network, body, schema, and timeout failures all preserve the last known good config.
    }
  }

  private evaluate(
    key: string,
    suppliedUser: EvaluationUser | undefined,
    fallback: JsonValue,
  ): Evaluation | undefined {
    if (this.closed || !this.snapshot || !Object.hasOwn(this.snapshot.flags, key)) return;
    const user = suppliedUser ?? this.user;
    if (!isUser(user)) return;
    const flag = this.snapshot.flags[key];
    if (this.keyType === "CLIENT") {
      if (canonical({ id: user.id, attributes: user.attributes }) !== this.contextFingerprint)
        return;
      if ("value" in flag) return { value: flag.value, variation: "resolved", user };
      return;
    }
    if (!("enabled" in flag)) return;
    try {
      const result = evaluateDetailed(flag, user, fallback);
      if (result.variation !== "fallback")
        return { value: result.value, variation: result.variation, user };
    } catch {
      // Evaluation must never turn a feature check into an application failure.
    }
  }

  isEnabled(key: string, user: EvaluationUser | undefined, fallback: boolean): boolean {
    const result = this.evaluate(key, user, fallback);
    if (!result || typeof result.value !== "boolean") return fallback;
    this.expose(key, result);
    return result.value;
  }

  getValue(key: string, user: EvaluationUser | undefined, fallback: JsonValue): JsonValue {
    const result = this.evaluate(key, user, fallback);
    if (!result) return fallback;
    this.expose(key, result);
    return clone(result.value);
  }

  onChange(callback: (snapshot: ConfigSnapshot) => void): () => void {
    if (!this.closed) this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private hasQueueSpace(): boolean {
    return !this.closed && this.queue.length + this.inFlightEvents < MAX_QUEUE_SIZE;
  }

  private expose(flagKey: string, result: Evaluation): void {
    if (!this.hasQueueSpace() || !globalThis.crypto?.subtle) return;
    const occurredAt = new Date().toISOString();
    try {
      const hash = globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(result.user.id),
      );
      this.queue.push(
        hash
          .then(
            (bytes): SdkEvent => ({
              kind: "exposure",
              flagKey,
              variation: result.variation,
              userHash: Array.from(new Uint8Array(bytes), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
              occurredAt,
            }),
          )
          .catch(() => undefined),
      );
    } catch {
      // A platform without usable Web Crypto still evaluates flags, but emits no exposure.
    }
  }

  track(metric: string, value: number, flagKey: string, user?: EvaluationUser): void {
    if (
      !this.hasQueueSpace() ||
      typeof metric !== "string" ||
      !metric.trim() ||
      metric.length > 100 ||
      !Number.isFinite(value)
    )
      return;
    const result = this.evaluate(flagKey, user, null);
    if (!result) return;
    this.queue.push(
      Promise.resolve({
        kind: "metric",
        flagKey,
        variation: result.variation,
        metric,
        value,
        occurredAt: new Date().toISOString(),
      }),
    );
  }

  flush(): Promise<void> {
    return this.closed ? Promise.resolve() : this.beginFlush();
  }

  private beginFlush(deadline?: number): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = this.sendEvents(deadline).finally(() => {
        this.flushPromise = undefined;
      });
    }
    return this.flushPromise;
  }

  private async sendEvents(deadline?: number): Promise<void> {
    // Drain only the events present at entry; a busy producer cannot make flush unbounded.
    let remaining = this.queue.length;
    while (remaining > 0 && (!this.closed || deadline !== undefined)) {
      const timeout = deadline === undefined ? this.requestTimeoutMs : deadline - Date.now();
      if (timeout <= 0) return;
      const batch = this.queue.splice(0, Math.min(MAX_BATCH_SIZE, remaining));
      remaining -= batch.length;
      this.inFlightEvents = batch.length;
      try {
        await this.request(
          async (signal) => {
            const events = (await Promise.all(batch)).filter(
              (event): event is SdkEvent => event !== undefined,
            );
            if (signal.aborted || !events.length) return;
            const headers = this.headers();
            headers.set("Content-Type", "application/json");
            const response = await this.fetcher(`${this.baseUrl}/api/sdk/events`, {
              method: "POST",
              headers,
              signal,
              redirect: "error",
              body: JSON.stringify({ events }),
            });
            // Ingest responses are not needed; release any response body without blocking shutdown.
            void response.body?.cancel().catch(() => undefined);
            if (!response.ok) throw new Error("SDK event delivery failed");
          },
          Math.min(timeout, this.requestTimeoutMs),
        );
      } catch {
        this.queue.unshift(...batch);
        return;
      } finally {
        this.inFlightEvents = 0;
      }
    }
  }

  private schedulePoll(): void {
    if (this.closed) return;
    this.pollTimer = backgroundTimer(() => {
      void this.refresh().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private scheduleFlush(): void {
    if (this.closed) return;
    this.flushTimer = backgroundTimer(() => {
      void this.flush().finally(() => this.scheduleFlush());
    }, this.flushIntervalMs);
  }

  private streamEvent(event: string, data: string): void {
    if (this.closed || event !== "config.changed") return;
    try {
      const payload: unknown = JSON.parse(data);
      if (
        !isRecord(payload) ||
        !isVersion(payload.version) ||
        !Array.isArray(payload.changedFlagKeys) ||
        !payload.changedFlagKeys.every((key) => typeof key === "string" && key.length > 0) ||
        this.snapshot?.version === payload.version
      )
        return;
      const version = payload.version;
      void this.refresh().then(() => {
        // A notification may arrive while a request for an earlier version is in flight.
        if (!this.closed && this.snapshot?.version !== version) return this.refresh();
      });
    } catch {
      // Malformed/unknown SSE messages never replace the cache.
    }
  }

  private async connectStream(): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    this.streamController = controller;
    let timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let received = false;
    try {
      const headers = this.headers(true);
      headers.set("Accept", "text/event-stream");
      const response = await abortable(
        this.fetcher(`${this.baseUrl}/api/sdk/stream`, {
          method: "GET",
          headers,
          signal: controller.signal,
          cache: "no-store",
          redirect: "error",
        }),
        controller.signal,
      );
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream")
      ) {
        void response.body?.cancel().catch(() => undefined);
        return;
      }
      reader = response.body.getReader();
      this.streamReader = reader;
      const decoder = new TextDecoder();
      const parser = new SseParser((event, data) => this.streamEvent(event, data));
      while (!this.closed && !controller.signal.aborted) {
        clearTimeout(timer);
        // Keepalives reset this deadline; normal server rotation after 55 seconds reconnects.
        timer = backgroundTimer(() => controller.abort(), 65_000);
        const chunk = await abortable(reader.read(), controller.signal);
        if (chunk.done) {
          parser.push(decoder.decode());
          parser.end();
          break;
        }
        received = true;
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      // Polling continues independently during stream failures.
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          /* A noncompliant reader may still be settling. */
        }
      }
      this.streamController = undefined;
      this.streamReader = undefined;
      if (!this.closed) {
        void this.refresh();
        this.streamFailures = received ? 0 : Math.min(this.streamFailures + 1, 5);
        const delay = Math.min(
          this.pollIntervalMs,
          1_000 * 2 ** Math.max(0, this.streamFailures - 1),
        );
        this.reconnectTimer = backgroundTimer(() => {
          void this.connectStream();
        }, delay);
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.listeners.clear();
    clearTimeout(this.pollTimer);
    clearTimeout(this.flushTimer);
    clearTimeout(this.reconnectTimer);
    this.streamController?.abort();
    void this.streamReader?.cancel().catch(() => undefined);
    for (const controller of this.requests) controller.abort();
    const deadline = Date.now() + this.requestTimeoutMs;
    this.closePromise = (async () => {
      await this.refreshPromise;
      await this.flushPromise;
      await this.beginFlush(deadline);
      this.queue = [];
    })();
    return this.closePromise;
  }
}

/** Initialize with one bounded config attempt. Offline initialization returns a usable fallback client. */
export async function init(options: FlagForgeOptions): Promise<FlagForgeClient> {
  const client = new Client(options);
  await client.refresh();
  client.start();
  return client;
}
