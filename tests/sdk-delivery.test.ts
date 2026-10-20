import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SdkEventInput, ServerFlagConfig } from "@flagforge/contracts";
import { createDeliveryHandlers, type DeliveryStore } from "../lib/sdk-delivery";
import { init } from "../packages/sdk/src/index";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const user = { id: "customer-example", attributes: { country: "IN", plan: "pro" } };
function flag(key = "checkout_refresh", version = 1): ServerFlagConfig {
  return {
    key,
    type: "RELEASE",
    enabled: true,
    rules: { rules: [], defaultServe: { rolloutPercent: 100 } },
    onValue: true,
    offValue: false,
    version,
  };
}

function fixture() {
  const state = {
    revoked: false,
    down: false,
    reads: 0,
    flags: [flag(), flag("older_high_version", 999)],
    received: [] as Array<{ environmentId: string; events: SdkEventInput[] }>,
  };
  const store: DeliveryStore = {
    async authenticate(hashedKey) {
      if (state.down) throw new Error("Database unavailable");
      if (state.revoked || ![hash("test-server"), hash("test-client")].includes(hashedKey))
        return null;
      return {
        id: hashedKey,
        type: hashedKey === hash("test-client") ? "CLIENT" : "SERVER",
        environmentId: "env-staging",
        environmentKey: "staging",
      };
    },
    async flags(environmentId) {
      state.reads++;
      assert.equal(environmentId, "env-staging");
      if (state.down) throw new Error("Database unavailable");
      return structuredClone(state.flags);
    },
    async ingest(key, events) {
      state.received.push({ environmentId: key.environmentId, events });
    },
  };
  const handlers = createDeliveryHandlers(store, { pollMs: 20, streamMs: 10_000 });
  const request = (path = "config", key = "test-server", init: RequestInit = {}) =>
    new Request(`http://delivery.test/api/sdk/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...Object.fromEntries(new Headers(init.headers)) },
    });
  return { state, store, handlers, request };
}

test("config authenticates before returning data or 304; invalid/revoked keys stay private", async () => {
  const { state, handlers, request } = fixture();
  assert.equal((await handlers.config(request("config", "wrong"))).status, 401);
  const response = await handlers.config(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private/);
  const etag = response.headers.get("etag")!;
  assert.ok((await response.json()).data.flags.checkout_refresh.rules);
  const unchanged = await handlers.config(
    request("config", "test-server", { headers: { "If-None-Match": `"other", W/${etag}` } }),
  );
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  state.revoked = true;
  assert.equal(
    (
      await handlers.config(
        request("config", "test-server", { headers: { "If-None-Match": etag } }),
      )
    ).status,
    401,
  );
});

test("revision and ETag detect lower-version updates, removals and restores", async () => {
  const { state, handlers, request } = fixture();
  const initial = await handlers.config(request());
  const initialVersion = (await initial.json()).data.version;
  const oldEtag = initial.headers.get("etag")!;
  state.flags[0].version++;
  state.flags[0].enabled = false;
  const changed = await handlers.config(
    request("config", "test-server", { headers: { "If-None-Match": oldEtag } }),
  );
  assert.equal(changed.status, 200);
  assert.notEqual((await changed.json()).data.version, initialVersion);
  state.flags.shift();
  const removed = await handlers.config(request());
  const removedTag = removed.headers.get("etag");
  assert.equal((await removed.json()).data.flags.checkout_refresh, undefined);
  state.flags.push(flag());
  assert.notEqual((await handlers.config(request())).headers.get("etag"), removedTag);
});

test("CLIENT context is mandatory; responses expose only resolved values, never rules", async () => {
  const { state, handlers, request } = fixture();
  state.flags[0].rules = {
    rules: [
      {
        id: "rule_country",
        description: "India only",
        conditions: [{ attribute: "country", operator: "equals", values: ["IN"] }],
        serve: { rolloutPercent: 100 },
      },
    ],
    defaultServe: { rolloutPercent: 0 },
  };
  assert.equal((await handlers.config(request("config", "test-client"))).status, 400);
  assert.equal(
    (
      await handlers.config(
        request("config", "test-client", { headers: { "X-FlagForge-Context": "%bad" } }),
      )
    ).status,
    400,
  );
  const context = { "X-FlagForge-Context": encodeURIComponent(JSON.stringify(user)) };
  const response = await handlers.config(request("config", "test-client", { headers: context }));
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload.data.flags.checkout_refresh).sort(), [
    "key",
    "type",
    "value",
    "version",
  ]);
  assert.equal(payload.data.flags.checkout_refresh.value, true);
  const otherUser = { id: "other", attributes: { country: "US" } };
  const other = await handlers.config(
    request("config", "test-client", {
      headers: {
        "X-FlagForge-Context": encodeURIComponent(JSON.stringify(otherUser)),
        "If-None-Match": response.headers.get("etag")!,
      },
    }),
  );
  assert.equal(other.status, 200);
  assert.equal((await other.json()).data.flags.checkout_refresh.value, false);
});

test("events are bounded, validated, private and scoped by key not caller environment", async () => {
  const { state, handlers, request } = fixture();
  const event = {
    kind: "exposure",
    flagKey: "checkout_refresh",
    variation: "on",
    userHash: hash(user.id),
  };
  const send = (body: unknown) =>
    handlers.events(
      request("events", "test-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  assert.equal((await send({ environmentId: "other-tenant", events: [event] })).status, 202);
  assert.equal(state.received[0].environmentId, "env-staging");
  assert.equal((await send({ events: [{ ...event, flagKey: "other_tenant_flag" }] })).status, 400);
  assert.equal((await send({ events: [{ ...event, userHash: "raw-user-id" }] })).status, 400);
  assert.equal((await send({ events: [] })).status, 400);
  assert.equal((await send({ events: Array.from({ length: 501 }, () => event) })).status, 400);
  assert.equal((await send({ events: [event], extra: "x".repeat(262144) })).status, 413);
  assert.equal(
    (await send({ events: [{ ...event, occurredAt: "2099-01-01T00:00:00.000Z" }] })).status,
    400,
  );
  state.revoked = true;
  assert.equal((await send({ events: [event] })).status, 401);
  assert.equal(state.received.length, 1);
});

test("CORS permits browser SDK headers without cookies; failures do not expose exceptions", async () => {
  const { state, handlers, request } = fixture();
  const options = handlers.options();
  assert.equal(options.status, 204);
  assert.match(options.headers.get("access-control-allow-headers")!, /Authorization/);
  assert.equal(options.headers.has("access-control-allow-credentials"), false);
  state.down = true;
  const failed = await handlers.config(request());
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /Database unavailable/);
});

test("SSE uses real delivery handlers with SDK, propagates change under 3s, retains outage cache", async (t) => {
  const { state, handlers } = fixture();
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (state.down) throw new Error("Delivery offline");
    if (request.url.endsWith("/config")) return handlers.config(request);
    if (request.url.endsWith("/stream")) return handlers.stream(request);
    return handlers.events(request);
  };
  const client = await init({
    baseUrl: "http://delivery.test",
    sdkKey: "test-server",
    fetch: transport,
    pollIntervalMs: 30_000,
  });
  t.after(() => client.close());
  assert.equal(client.isEnabled("checkout_refresh", user, false), true);
  await delay(40);
  const start = performance.now();
  state.flags[0].enabled = false;
  state.flags[0].version++;
  while (client.isEnabled("checkout_refresh", user, true)) {
    assert.ok(performance.now() - start < 3000, "SSE should deliver in less than 3 seconds");
    await delay(10);
  }
  t.diagnostic(
    `Delivery handler → SDK cache: ${(performance.now() - start).toFixed(1)} ms (20 ms test poll)`,
  );
  client.track("checkout_conversion", 1, "checkout_refresh", user);
  await client.flush();
  assert.ok(
    state.received.flatMap((batch) => batch.events).some((event) => event.kind === "metric"),
  );
  assert.ok(
    state.received
      .flatMap((batch) => batch.events)
      .every((event) => event.kind !== "exposure" || event.userHash === hash(user.id)),
  );
  state.down = true;
  await client.refresh();
  assert.equal(client.isEnabled("checkout_refresh", user, true), false);
});

test("SSE cancellation/revocation stops polling and releases timers", async () => {
  const { state, handlers, request } = fixture();
  const controller = new AbortController();
  const response = await handlers.stream(
    request("stream", "test-server", { signal: controller.signal }),
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: config.changed/);
  state.revoked = true;
  assert.equal((await reader.read()).done, true);
  const count = state.reads;
  await delay(50);
  assert.equal(state.reads, count);
  state.revoked = false;
  const another = await handlers.stream(
    request("stream", "test-server", { signal: controller.signal }),
  );
  await another.body!.cancel();
  const cancelledReads = state.reads;
  await delay(50);
  assert.equal(state.reads, cancelledReads);
});

test("production one-second stream cadence delivers through SDK in under three seconds", async (t) => {
  const { state, store } = fixture();
  const handlers = createDeliveryHandlers(store);
  const client = await init({
    baseUrl: "http://delivery.test",
    sdkKey: "test-server",
    fetch: async (input, options) => {
      const request = new Request(input, options);
      if (request.url.endsWith("/config")) return handlers.config(request);
      if (request.url.endsWith("/stream")) return handlers.stream(request);
      return handlers.events(request);
    },
  });
  t.after(() => client.close());
  await delay(50);
  const start = performance.now();
  state.flags[0].enabled = false;
  while (client.isEnabled("checkout_refresh", user, true)) {
    assert.ok(performance.now() - start < 3000);
    await delay(20);
  }
  t.diagnostic(
    `Default server cadence → SDK: ${(performance.now() - start).toFixed(1)} ms; in-memory store, no dashboard/DB latency`,
  );
});
