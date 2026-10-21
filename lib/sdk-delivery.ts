import { createHash } from "node:crypto";
import {
  evaluationUserSchema,
  ingestSdkEventsRequestSchema,
  sdkConfigResponseSchema,
  type EvaluationUser,
  type SdkEventInput,
  type ServerFlagConfig,
} from "@flagforge/contracts";
import { evaluateFlag } from "../packages/evaluator/dist/index.js";

export type DeliveryKey = {
  id: string;
  type: "SERVER" | "CLIENT";
  environmentId: string;
  environmentKey: string;
};

/** Persistence boundary shared by the production routes and offline integration tests. */
export interface DeliveryStore {
  authenticate(hashedKey: string): Promise<DeliveryKey | null>;
  flags(environmentId: string): Promise<ServerFlagConfig[]>;
  ingest(key: DeliveryKey, events: SdkEventInput[]): Promise<void>;
}

class DeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 256 * 1024;
const jsonHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization, X-FlagForge-Context, Origin",
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Object key order must not turn equivalent contexts/configs into different revisions.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contextFor(request: Request, key: DeliveryKey): EvaluationUser | undefined {
  if (key.type === "SERVER") return undefined;
  const encoded = request.headers.get("x-flagforge-context");
  if (!encoded || encoded.length > 8192) {
    throw new DeliveryError(
      400,
      "INVALID_CONTEXT",
      "Client keys require a bounded X-FlagForge-Context header.",
    );
  }
  try {
    return evaluationUserSchema.parse(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    throw new DeliveryError(400, "INVALID_CONTEXT", "Supply a user id and scalar attributes.");
  }
}

async function authorized(request: Request, store: DeliveryStore) {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer ([^\s]{1,512})$/i.exec(header)?.[1];
  const hashed = token ? digest(token) : "";
  const key = hashed ? await store.authenticate(hashed) : null;
  if (!key) throw new DeliveryError(401, "INVALID_SDK_KEY", "A valid SDK key is required.");
  return { key, hashed };
}

async function snapshot(store: DeliveryStore, key: DeliveryKey, user?: EvaluationUser) {
  const records = await store.flags(key.environmentId);
  const raw = Object.fromEntries(
    records.sort((a, b) => a.key.localeCompare(b.key)).map((flag) => [flag.key, flag]),
  );
  // Content revision detects every config change, removal and restore, not max(row.version).
  const revision = digest(canonicalJson({ environmentId: key.environmentId, flags: raw }));
  const flags =
    key.type === "SERVER"
      ? raw
      : Object.fromEntries(
          records.map((flag) => [
            flag.key,
            {
              key: flag.key,
              type: flag.type,
              value: evaluateFlag(flag, user!, flag.offValue),
              version: flag.version,
            },
          ]),
        );
  const data = sdkConfigResponseSchema.parse({
    environmentKey: key.environmentKey,
    version: Number.parseInt(revision.slice(0, 12), 16),
    flags,
  });
  const etag = `"${digest(canonicalJson({ environmentId: key.environmentId, keyType: key.type, user, data }))}"`;
  const fingerprints = Object.fromEntries(
    records.map((flag) => [flag.key, digest(canonicalJson(flag))]),
  );
  return { data, etag, fingerprints };
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new DeliveryError(415, "INVALID_CONTENT_TYPE", "Send application/json.");
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new DeliveryError(413, "PAYLOAD_TOO_LARGE", "Event batches must be at most 256 KiB.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DeliveryError(400, "INVALID_EVENTS", "An event batch is required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new DeliveryError(413, "PAYLOAD_TOO_LARGE", "Event batches must be at most 256 KiB.");
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(400, "INVALID_EVENTS", "Send a valid JSON event batch.");
  } finally {
    reader.releaseLock();
  }
}

/** CORS intentionally permits only noncredentialed SDK requests; never cookie authentication. */
function cors(response: Response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Expose-Headers", "ETag");
  return response;
}

function failure(error: unknown): Response {
  const known = error instanceof DeliveryError;
  // Never log keys, user contexts, payloads, or raw Prisma exception details.
  return cors(
    Response.json(
      {
        error: {
          code: known ? error.code : "DELIVERY_UNAVAILABLE",
          message: known ? error.message : "Configuration delivery is temporarily unavailable.",
        },
      },
      { status: known ? error.status : 503, headers: jsonHeaders },
    ),
  );
}

export function createDeliveryHandlers(
  store: DeliveryStore,
  options: { pollMs?: number; streamMs?: number } = {},
) {
  const pollMs = options.pollMs ?? 1000;
  const streamMs = options.streamMs ?? 55_000;
  return {
    options() {
      return cors(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, If-None-Match, X-FlagForge-Context",
            "Access-Control-Max-Age": "600",
          },
        }),
      );
    },
    async config(request: Request) {
      try {
        const { key } = await authorized(request, store);
        const current = await snapshot(store, key, contextFor(request, key));
        const headers = { ...jsonHeaders, ETag: current.etag };
        const tags = request.headers
          .get("if-none-match")
          ?.split(",")
          .map((tag) => tag.trim().replace(/^W\//, ""));
        if (tags?.some((tag) => tag === current.etag || tag === "*")) {
          return cors(new Response(null, { status: 304, headers }));
        }
        return cors(Response.json({ data: current.data }, { headers }));
      } catch (error) {
        return failure(error);
      }
    },
    async events(request: Request) {
      try {
        const { key } = await authorized(request, store);
        const parsed = ingestSdkEventsRequestSchema.safeParse(await boundedJson(request));
        if (!parsed.success)
          throw new DeliveryError(
            400,
            "INVALID_EVENTS",
            "Send 1 to 500 valid exposure or metric events.",
          );
        const now = Date.now();
        const records = await store.flags(key.environmentId);
        const allowed = new Set(records.map((flag) => flag.key));
        for (const event of parsed.data.events) {
          if (
            !allowed.has(event.flagKey) ||
            !["on", "off", "resolved"].includes(event.variation) ||
            (event.kind === "exposure" && !/^[a-f0-9]{64}$/.test(event.userHash)) ||
            (event.occurredAt &&
              (Date.parse(event.occurredAt) > now + 300_000 ||
                Date.parse(event.occurredAt) < now - 7 * 86400_000))
          ) {
            throw new DeliveryError(
              400,
              "INVALID_EVENTS",
              "Events must reference this environment, SHA-256 user hashes, and recent timestamps.",
            );
          }
        }
        await store.ingest(key, parsed.data.events);
        return cors(
          Response.json(
            { data: { accepted: parsed.data.events.length } },
            { status: 202, headers: jsonHeaders },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
    async stream(request: Request) {
      try {
        const { key, hashed } = await authorized(request, store);
        const user = contextFor(request, key);
        let previous = await snapshot(store, key, user);
        let stop = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let ended = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expiry = setTimeout(() => stop(), streamMs);
            stop = () => {
              if (ended) return;
              ended = true;
              clearTimeout(timer);
              clearTimeout(expiry);
              request.signal.removeEventListener("abort", stop);
              try {
                controller.close();
              } catch {
                /* Consumer cancellation already closed it. */
              }
            };
            function send(changedFlagKeys: string[]) {
              controller.enqueue(
                encoder.encode(
                  `event: config.changed\ndata: ${JSON.stringify({ version: previous.data.version, changedFlagKeys })}\n\n`,
                ),
              );
            }
            async function tick() {
              try {
                if (ended) return;
                // DB polling crosses processes/deployments without touching Phase 2 writes.
                const active = await store.authenticate(hashed);
                if (ended) return;
                if (!active || active.environmentId !== key.environmentId) {
                  stop();
                  return;
                }
                const current = await snapshot(store, key, user);
                if (ended) return;
                if (current.etag !== previous.etag) {
                  const changed = new Set([
                    ...Object.keys(previous.fingerprints),
                    ...Object.keys(current.fingerprints),
                  ]);
                  const keys = [...changed].filter(
                    (name) => previous.fingerprints[name] !== current.fingerprints[name],
                  );
                  previous = current;
                  send(keys);
                } else controller.enqueue(encoder.encode(": keepalive\n\n"));
                timer = setTimeout(() => void tick(), pollMs);
              } catch {
                stop();
              }
            }
            request.signal.addEventListener("abort", stop, { once: true });
            if (request.signal.aborted) {
              stop();
              return;
            }
            send(Object.keys(previous.data.flags));
            timer = setTimeout(() => void tick(), pollMs);
          },
          cancel() {
            stop();
          },
        });
        return cors(
          new Response(body, {
            headers: {
              ...jsonHeaders,
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "private, no-cache, no-transform",
              "X-Accel-Buffering": "no",
            },
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  };
}
