import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import {
  init,
  type ConfigSnapshot,
  type EvaluationUser,
  type FlagForgeOptions,
  type JsonValue,
  type SdkEvent,
  type ServerFlagConfig,
} from "../packages/sdk/src/index.js";
import { SseParser } from "../packages/sdk/src/sse.js";

const user: EvaluationUser = {
  id: "customer-private-123",
  attributes: { country: "IN", plan: "pro" },
};
const baseUrl = "https://flags.example.test";
const sdkKey = "secret-sdk-key";

function flag(
  key = "checkout",
  onValue: JsonValue = true,
  offValue: JsonValue = false,
): ServerFlagConfig {
  return {
    key,
    type: "RELEASE",
    enabled: true,
    rules: { rules: [], defaultServe: { rolloutPercent: 100 } },
    onValue,
    offValue,
    version: 1,
  };
}

function config(version = 1, flags: Record<string, unknown> = { checkout: flag() }) {
  return { data: { environmentKey: "production", version, flags } };
}

function json(value: unknown, etag?: string): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...(etag ? { ETag: etag } : {}) },
  });
}

function fakeFetch(
  handler: (url: URL, request: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return async (input, request) => handler(new URL(String(input)), request ?? {});
}

async function client(t: TestContext, options: Partial<FlagForgeOptions> = {}) {
  const sdk = await init({
    baseUrl,
    sdkKey,
    streaming: false,
    fetch: fakeFetch((url) =>
      json(url.pathname.endsWith("/config") ? config() : { data: { accepted: true } }),
    ),
    ...options,
  });
  t.after(() => sdk.close());
  return sdk;
}

async function until(predicate: () => boolean, message = "condition did not become true") {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("initial SERVER config uses the evaluator locally and preserves false, zero, and JSON values", async (t) => {
  let configRequests = 0;
  const targeted = flag("targeted");
  targeted.rules = {
    rules: [
      {
        id: "rule_pro",
        description: "Pro accounts",
        serve: { rolloutPercent: 100 },
        conditions: [{ attribute: "plan", operator: "equals", values: ["pro"] }],
      },
    ],
    defaultServe: { rolloutPercent: 0 },
  };
  const sdk = await client(t, {
    // A prefix never overrides the explicit/default SERVER key type.
    sdkKey: "ff_client_prefix_is_not_authority",
    fetch: fakeFetch((url, request) => {
      assert.equal(new Headers(request.headers).has("X-FlagForge-Context"), false);
      if (!url.pathname.endsWith("/config")) return json({ data: {} });
      configRequests++;
      return json(
        config(1, {
          checkout: flag("checkout", false),
          zero: flag("zero", 0, 9),
          object: flag("object", { nested: [false, 0] }),
          targeted,
        }),
      );
    }),
  });
  assert.equal(sdk.isEnabled("checkout", user, true), false);
  assert.equal(sdk.getValue("zero", user, 99), 0);
  assert.equal(sdk.isEnabled("zero", user, true), true, "non-boolean values use boolean fallback");
  assert.equal(sdk.isEnabled("targeted", user, false), true);
  assert.equal(sdk.isEnabled("targeted", { ...user, attributes: { plan: "free" } }, true), false);
  const value = sdk.getValue("object", user, null) as { nested: JsonValue[] };
  value.nested.push("mutation");
  assert.deepEqual(sdk.getValue("object", user, null), { nested: [false, 0] });
  assert.equal(sdk.isEnabled("missing", user, true), true);
  assert.equal(sdk.getValue("constructor", user, "safe"), "safe");
  assert.equal(sdk.getValue("checkout", undefined, "no-user"), "no-user");
  assert.equal(configRequests, 1, "evaluations do not fetch");
});

test("offline init safely falls back, recovers on refresh, and keeps cached config through server loss", async (t) => {
  let online = false;
  const sdk = await client(t, {
    fetch: fakeFetch(() => {
      if (!online) throw new Error("server unavailable");
      return json(config());
    }),
  });
  assert.equal(sdk.isEnabled("checkout", user, false), false);
  assert.equal(sdk.getValue("checkout", user, 0), 0);
  online = true;
  await sdk.refresh();
  assert.equal(sdk.isEnabled("checkout", user, false), true);
  online = false;
  await sdk.refresh();
  assert.equal(sdk.isEnabled("checkout", user, false), true);
  online = true;
});

test("ETags, snapshot equality, subscription isolation, removals, and refresh coalescing", async (t) => {
  let response = () => json(config(), '"v1"');
  let requests = 0;
  let lastTag: string | null = null;
  const sdk = await client(t, {
    fetch: fakeFetch((url, request) => {
      if (url.pathname.endsWith("/events")) return json({ data: {} });
      requests++;
      lastTag = new Headers(request.headers).get("If-None-Match");
      return response();
    }),
  });
  const changes: ConfigSnapshot[] = [];
  const unsubscribe = sdk.onChange((snapshot) => changes.push(snapshot));
  sdk.onChange(() => {
    throw new Error("consumer error");
  });
  let otherListener = 0;
  sdk.onChange(() => {
    otherListener++;
  });
  response = () => new Response(null, { status: 304 });
  const first = sdk.refresh();
  assert.equal(first, sdk.refresh());
  await Promise.all([first, sdk.refresh(), sdk.refresh()]);
  assert.equal(requests, 2);
  assert.equal(lastTag, '"v1"');
  assert.equal(changes.length, 0);
  response = () =>
    json(
      {
        data: {
          flags: { checkout: { ...flag(), key: "checkout" } },
          version: 1,
          environmentKey: "production",
        },
      },
      '"same-content"',
    );
  await sdk.refresh();
  assert.equal(changes.length, 0);
  response = () => json(config(2, {}), '"v2"');
  await sdk.refresh();
  assert.equal(changes.length, 1);
  assert.equal(otherListener, 1);
  assert.ok(Object.isFrozen(changes[0]));
  assert.ok(Object.isFrozen(changes[0].flags));
  assert.equal(sdk.isEnabled("checkout", user, false), false);
  unsubscribe();
  response = () => json(config(3), '"v3"');
  await sdk.refresh();
  assert.equal(changes.length, 1);
  assert.equal(otherListener, 2);
});

test("invalid payloads are rejected atomically without poisoning the snapshot or ETag", async (t) => {
  let response = () => json(config(), '"good"');
  const tags: (string | null)[] = [];
  const sdk = await client(t, {
    fetch: fakeFetch((url, request) => {
      if (url.pathname.endsWith("/events")) return json({ data: {} });
      tags.push(new Headers(request.headers).get("If-None-Match"));
      return response();
    }),
  });
  let changes = 0;
  sdk.onChange(() => {
    changes++;
  });
  const invalid = [
    null,
    config().data,
    { data: { environmentKey: "production", version: -1, flags: {} } },
    { data: { environmentKey: "production", version: 2, flags: [] } },
    config(2, { checkout: { ...flag(), key: "another" } }),
    config(2, { checkout: { ...flag(), onValue: undefined } }),
    config(2, { checkout: { ...flag(), enabled: "true" } }),
    config(2, {
      checkout: { ...flag(), rules: { rules: [], defaultServe: { rolloutPercent: 101 } } },
    }),
    config(2, { checkout: { ...flag(), type: "UNKNOWN" } }),
    config(2, { checkout: { key: "checkout", type: "RELEASE", value: false, version: 2 } }),
    config(2, { checkout: flag("checkout", false), bad: { ...flag("bad"), rules: null } }),
  ];
  for (const payload of invalid) {
    response = () => json(payload, '"poison"');
    await sdk.refresh();
    assert.equal(sdk.isEnabled("checkout", user, false), true);
  }
  response = () => new Response("{broken json", { headers: { ETag: '"poison"' } });
  await sdk.refresh();
  response = () => new Response("unavailable", { status: 503, headers: { ETag: '"poison"' } });
  await sdk.refresh();
  assert.equal(changes, 0);
  assert.ok(tags.slice(1).every((tag) => tag === '"good"'));
  assert.equal(sdk.isEnabled("checkout", user, false), true);
});

test("CLIENT context is header-only, immutable, attribute-sensitive, and never inferred from the key", async (t) => {
  const original = { id: "customer/é", attributes: { country: "IN", plan: "pro" } };
  const context = structuredClone(original);
  const requests: { url: URL; headers: Headers; body?: BodyInit | null }[] = [];
  let payload = config(1, {
    checkout: { key: "checkout", type: "RELEASE", value: false, version: 1 },
    zero: { key: "zero", type: "OPS", value: 0, version: 1 },
  });
  const events: SdkEvent[] = [];
  const sdk = await client(t, {
    keyType: "CLIENT",
    user: original,
    fetch: fakeFetch((url, request) => {
      requests.push({ url, headers: new Headers(request.headers), body: request.body });
      if (url.pathname.endsWith("/events")) {
        events.push(...JSON.parse(String(request.body)).events);
        return json({ data: {} });
      }
      return json(payload);
    }),
  });
  original.id = "different";
  original.attributes.plan = "free";
  assert.equal(sdk.isEnabled("checkout", undefined, true), false);
  assert.equal(sdk.getValue("zero", context, 9), 0);
  assert.equal(
    sdk.isEnabled("checkout", { ...context, attributes: { plan: "pro", country: "IN" } }, true),
    false,
  );
  assert.equal(sdk.isEnabled("checkout", original, true), true);
  assert.equal(
    sdk.isEnabled("checkout", { ...context, attributes: { plan: "free", country: "IN" } }, true),
    true,
  );
  sdk.track("conversion", 0, "checkout", original);
  await sdk.flush();
  assert.equal(events.length, 3, "mismatched contexts emit no exposure or metric");
  assert.ok(events.every((event) => event.variation === "resolved"));
  assert.equal(
    requests[0].headers.get("X-FlagForge-Context"),
    encodeURIComponent(JSON.stringify(context)),
  );
  assert.ok(
    requests.every(({ url, headers }) => {
      assert.equal(url.search, "");
      assert.equal(headers.get("Authorization"), `Bearer ${sdkKey}`);
      return !url.href.includes(sdkKey) && !url.href.includes(context.id);
    }),
  );
  const eventRequest = requests.find(({ url }) => url.pathname.endsWith("/events"))!;
  assert.equal(eventRequest.headers.has("X-FlagForge-Context"), false);
  assert.ok(!String(eventRequest.body).includes(context.id));
  payload = config(2, { checkout: flag() });
  await sdk.refresh();
  assert.equal(
    sdk.isEnabled("checkout", context, true),
    false,
    "raw CLIENT rules cannot poison a resolved cache",
  );
});

test("invalid initialization options fail early without exposing credentials", async () => {
  await assert.rejects(init({ baseUrl, sdkKey, keyType: "CLIENT" }), /require a user context/);
  await assert.rejects(init({ baseUrl: "not-a-url", sdkKey }), /HTTP\(S\)/);
  await assert.rejects(
    init({ baseUrl: `${baseUrl}?sdkKey=secret`, sdkKey }),
    /without credentials/,
  );
  await assert.rejects(init({ baseUrl, sdkKey, requestTimeoutMs: 0 }), /positive/);
  await assert.rejects(
    init({ baseUrl, sdkKey: "hidden\r\nvalue" }),
    (error: Error) => !error.message.includes("hidden"),
  );
});

test("initial and body timeouts bound uncooperative fetches and retain safe cached values", async (t) => {
  let signal: AbortSignal | null | undefined;
  let mode = "hang";
  const sdk = await client(t, {
    requestTimeoutMs: 25,
    fetch: fakeFetch((_url, request) => {
      signal = request.signal;
      if (mode === "hang") return new Promise<Response>(() => {});
      if (mode === "body") return new Response(new ReadableStream({ start() {} }));
      return json(config());
    }),
  });
  assert.equal(signal?.aborted, true);
  assert.equal(sdk.isEnabled("checkout", user, false), false);
  mode = "ready";
  await sdk.refresh();
  assert.equal(sdk.isEnabled("checkout", user, false), true);
  mode = "body";
  await sdk.refresh();
  assert.equal(signal?.aborted, true);
  assert.equal(sdk.isEnabled("checkout", user, false), true);
  mode = "ready";
});

test("polling recovers missed updates while the stream is unavailable", async (t) => {
  let version = 1;
  let streams = 0;
  const sdk = await client(t, {
    streaming: true,
    pollIntervalMs: 20,
    fetch: fakeFetch((url) => {
      if (url.pathname.endsWith("/stream")) {
        streams++;
        throw new Error("stream offline");
      }
      return json(config(version, { checkout: flag("checkout", version === 1) }));
    }),
  });
  let changes = 0;
  sdk.onChange(() => {
    changes++;
  });
  version = 2;
  await until(() => changes === 1);
  assert.equal(sdk.isEnabled("checkout", user, true), false);
  assert.ok(streams >= 1);
});

test("authenticated SSE handles CRLF, multiline JSON, UTF-8 and byte boundaries, initial events, and reconnects", async (t) => {
  let version = 1;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streams = 0;
  let configs = 0;
  let cancelled = 0;
  const headers: Headers[] = [];
  const sdk = await client(t, {
    streaming: true,
    pollIntervalMs: 1_000,
    fetch: fakeFetch((url, request) => {
      if (url.pathname.endsWith("/stream")) {
        streams++;
        headers.push(new Headers(request.headers));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              controller = stream;
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
        );
      }
      configs++;
      return json(config(version, { checkout: flag("checkout", version === 1) }));
    }),
  });
  let changes = 0;
  sdk.onChange(() => {
    changes++;
  });
  await until(() => !!controller);
  const send = (data: string) => {
    for (const byte of new TextEncoder().encode(data)) controller!.enqueue(Uint8Array.of(byte));
  };
  send(': keepalive\r\nevent: config.changed\r\ndata: {"version":1,"changedFlagKeys":[]}\r\n\r\n');
  send("event: config.changed\ndata: not-json\n\nevent: other\ndata: {}\n\n");
  version = 2;
  send(
    'event: config.changed\r\ndata: {"version":2,\r\ndata: "changedFlagKeys":["checkout","café"]}\r\n\r\n',
  );
  await until(() => changes === 1);
  assert.equal(sdk.isEnabled("checkout", user, true), false);
  assert.equal(configs, 2, "initial and malformed events cause no redundant refresh");
  controller!.close();
  await until(() => streams >= 2, "normal server EOF should reconnect");
  assert.ok(headers.every((value) => value.get("Authorization") === `Bearer ${sdkKey}`));
  assert.ok(headers.every((value) => value.get("Accept") === "text/event-stream"));
  await sdk.close();
  assert.ok(cancelled >= 1);
});

test("SSE notification received during an older refresh triggers a follow-up fetch", async (t) => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveOld: ((response: Response) => void) | undefined;
  let requests = 0;
  const sdk = await client(t, {
    streaming: true,
    fetch: fakeFetch((url) => {
      if (url.pathname.endsWith("/stream")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      }
      requests++;
      if (requests === 2)
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return json(config(requests === 1 ? 1 : 3));
    }),
  });
  const refresh = sdk.refresh();
  controller!.enqueue(
    new TextEncoder().encode('event: config.changed\ndata: {"version":3,"changedFlagKeys":[]}\n\n'),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveOld!(json(config(2)));
  await refresh;
  await until(() => requests === 3);
});

test("SSE framing completes bare CR delimiters, discards incomplete events, and bounds buffering", () => {
  const received: [string, string][] = [];
  const parser = new SseParser((event, data) => received.push([event, data]));
  parser.push("event: config.changed\rdata: first\rdata: second\r\r");
  parser.end();
  assert.deepEqual(received, [["config.changed", "first\nsecond"]]);
  parser.push("event: config.changed\ndata: incomplete");
  parser.end();
  assert.equal(received.length, 1);
  assert.throws(() => parser.push("x".repeat(65_537)), /too large/);
});

test("exposures use SHA-256 and true variations; fallbacks emit nothing; metrics retain zero", async (t) => {
  const batches: SdkEvent[][] = [];
  const sdk = await client(t, {
    user,
    fetch: fakeFetch((url, request) => {
      if (url.pathname.endsWith("/config")) {
        return json(
          config(1, {
            checkout: flag("checkout", false),
            off: { ...flag("off"), enabled: false },
            number: flag("number", 0),
          }),
        );
      }
      assert.equal(new Headers(request.headers).get("Authorization"), `Bearer ${sdkKey}`);
      assert.equal(new Headers(request.headers).has("X-FlagForge-Context"), false);
      assert.ok(!String(request.body).includes(user.id));
      batches.push(JSON.parse(String(request.body)).events);
      return json({ data: { accepted: true } });
    }),
  });
  sdk.isEnabled("checkout", undefined, true);
  sdk.getValue("off", user, true);
  sdk.isEnabled("missing", user, true);
  sdk.isEnabled("number", user, false);
  sdk.track("conversion", 0, "checkout");
  sdk.track("bad", Number.NaN, "checkout");
  sdk.track("", 1, "checkout");
  sdk.track("missing", 1, "absent");
  const first = sdk.flush();
  assert.equal(first, sdk.flush());
  await first;
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.deepEqual(
    batches[0].map((event) => event.variation),
    ["on", "off", "on"],
  );
  for (const event of batches[0]) {
    assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
    if (event.kind === "exposure") {
      assert.equal(event.userHash, createHash("sha256").update(user.id).digest("hex"));
    } else {
      assert.equal(event.value, 0);
    }
  }
  await sdk.flush();
  assert.equal(batches.length, 1, "empty queues do not post");
});

test("telemetry queue is bounded, batches stay at 500, and failed deliveries are retried", async (t) => {
  let fail = true;
  const batches: SdkEvent[][] = [];
  const sdk = await client(t, {
    user,
    fetch: fakeFetch((url, request) => {
      if (url.pathname.endsWith("/config")) return json(config());
      batches.push(JSON.parse(String(request.body)).events);
      return fail ? new Response(null, { status: 503 }) : json({ data: {} });
    }),
  });
  for (let value = 0; value < 1_205; value++) sdk.track("latency", value, "checkout");
  await sdk.flush();
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [500],
  );
  fail = false;
  await sdk.flush();
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [500, 500, 500],
  );
  const delivered = batches.slice(1).flat();
  assert.equal(delivered.length, 1_000);
  assert.deepEqual(
    delivered.map((event) => (event.kind === "metric" ? event.value : -1)),
    Array.from({ length: 1_000 }, (_, i) => i),
  );
});

test("flush interval delivers queued events without explicit flush", async (t) => {
  let delivered = 0;
  const sdk = await client(t, {
    flushIntervalMs: 15,
    fetch: fakeFetch((url, request) => {
      if (url.pathname.endsWith("/config")) return json(config());
      delivered += JSON.parse(String(request.body)).events.length;
      return json({ data: {} });
    }),
  });
  sdk.isEnabled("checkout", user, false);
  await until(() => delivered === 1);
});

test("close aborts polling, prevents late updates, clears timers, and is idempotent", async (t) => {
  let requests = 0;
  let pendingSignal: AbortSignal | null | undefined;
  let resolveLate: ((response: Response) => void) | undefined;
  const sdk = await client(t, {
    pollIntervalMs: 15,
    flushIntervalMs: 15,
    requestTimeoutMs: 50,
    fetch: fakeFetch((_url, request) => {
      requests++;
      if (requests === 1) return json(config());
      pendingSignal = request.signal;
      return new Promise<Response>((resolve) => {
        resolveLate = resolve;
      });
    }),
  });
  let changes = 0;
  sdk.onChange(() => {
    changes++;
  });
  await until(() => !!resolveLate);
  const closing = sdk.close();
  assert.equal(closing, sdk.close());
  await closing;
  assert.equal(pendingSignal?.aborted, true);
  resolveLate!(json(config(2)));
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(changes, 0);
  assert.equal(requests, 2);
  assert.equal(sdk.isEnabled("checkout", user, false), false);
  await sdk.refresh();
  await sdk.flush();
  assert.equal(requests, 2);
});

test("close flushes pending hashes and bounds an event transport that ignores abort", async (t) => {
  let hang = false;
  let posted = 0;
  let signal: AbortSignal | null | undefined;
  const options = {
    requestTimeoutMs: 35,
    fetch: fakeFetch((url, request) => {
      if (url.pathname.endsWith("/config")) return json(config());
      posted += JSON.parse(String(request.body)).events.length;
      signal = request.signal;
      return hang ? new Promise<Response>(() => {}) : json({ data: {} });
    }),
  };
  const sdk = await client(t, options);
  sdk.isEnabled("checkout", user, false);
  await sdk.close();
  assert.equal(posted, 1, "close waits for pending SHA-256 before flushing");
  const hanging = await client(t, options);
  hanging.track("metric", 1, "checkout", user);
  hang = true;
  const start = Date.now();
  await hanging.close();
  assert.ok(
    Date.now() - start < 1_000,
    "shutdown must be bounded even for a broken injected fetch",
  );
  assert.equal(signal?.aborted, true);
});

test("real fetch integrates with a local HTTP config, authenticated SSE, and event endpoint", async (t) => {
  let version = 1;
  let stream: import("node:http").ServerResponse | undefined;
  let events = 0;
  const routes: string[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${sdkKey}`);
    routes.push(request.url!);
    if (request.url === "/api/sdk/config") {
      if (request.headers["if-none-match"] === `"${version}"`) {
        response.writeHead(304).end();
      } else {
        response.writeHead(200, { "Content-Type": "application/json", ETag: `"${version}"` });
        response.end(
          JSON.stringify(config(version, { checkout: flag("checkout", version === 1) })),
        );
      }
    } else if (request.url === "/api/sdk/stream") {
      stream = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `event: config.changed\ndata: {"version":${version},"changedFlagKeys":[]}\n\n`,
      );
    } else if (request.url === "/api/sdk/events") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        events += JSON.parse(body).events.length;
        response.writeHead(200, { "Content-Type": "application/json" }).end('{"data":{}}');
      });
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const sdk = await init({
    baseUrl: `http://127.0.0.1:${address.port}`,
    sdkKey,
    requestTimeoutMs: 500,
  });
  t.after(() => sdk.close());
  await until(() => !!stream);
  assert.equal(sdk.isEnabled("checkout", user, false), true);
  let changed = false;
  sdk.onChange(() => {
    changed = true;
  });
  version = 2;
  stream!.write('event: config.changed\ndata: {"version":2,"changedFlagKeys":["checkout"]}\n\n');
  await until(() => changed);
  assert.equal(sdk.isEnabled("checkout", user, true), false);
  await sdk.flush();
  assert.equal(events, 2);
  assert.ok(routes.every((route) => !route.includes("?")));
  await sdk.close();
});
