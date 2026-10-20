import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import {
  createEvaluationStore,
  type EvaluationClient,
} from "../examples/next-app/lib/evaluation-store";
import { readEnvironment, type SdkOptions } from "../examples/next-app/lib/environment";
import { evaluateRequest } from "../examples/next-app/lib/evaluate-request";
import { DEFAULT_USER_ID } from "../examples/next-app/lib/evaluation";
import { cart, totalPaise } from "../examples/next-app/lib/cart";

const environment = readEnvironment({ FLAGFORGE_SDK_KEY: "test-only-server-key" });

test("environment failures are explicit and never reflect supplied secrets", () => {
  for (const env of [
    {},
    { FLAGFORGE_SDK_KEY: "replace_with_server_key" },
    { FLAGFORGE_SDK_KEY: "secret value" },
    { FLAGFORGE_SDK_KEY: "secret", FLAGFORGE_URL: "https://secret:password@example.test" },
    { FLAGFORGE_SDK_KEY: "secret", FLAGFORGE_URL: "file:///secret" },
    { FLAGFORGE_SDK_KEY: "secret", FLAGFORGE_FLAG_KEY: "SECRET_FLAG!" },
  ]) {
    const result = readEnvironment(env);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret|password|SECRET_FLAG/);
  }
  assert.equal(environment.ok, true);
  if (environment.ok) {
    assert.equal(environment.options.baseUrl, "http://localhost:3000");
    assert.equal(environment.options.keyType, "SERVER");
    assert.equal(environment.flagKey, "checkout_refresh");
  }
});

test("missing environment does not initialize the SDK", () => {
  const store = createEvaluationStore({
    environment: readEnvironment({}),
    init: async () => {
      throw new Error("Must not initialize");
    },
  });
  assert.equal(store.evaluate(DEFAULT_USER_ID).status, "configuration-error");
  store.close();
});

test("one asynchronous init serves cached per-user decisions and changes without leaking rules", async () => {
  let resolve!: (client: EvaluationClient) => void;
  let calls = 0;
  let hasConfig = false;
  let enabled = false;
  let closed = false;
  let changed = () => {};
  const client: EvaluationClient = {
    isEnabled(key, user, fallback) {
      assert.equal(key, "checkout_refresh");
      assert.deepEqual(user.attributes, { country: "IN", plan: "pro" });
      assert.equal(fallback, false);
      return hasConfig && enabled && user.id !== "excluded";
    },
    getValue(_key, _user, fallback) {
      return hasConfig ? { privateRules: "must-not-leak" } : fallback;
    },
    onChange(callback) {
      changed = callback;
    },
    close() {
      closed = true;
    },
  };
  const store = createEvaluationStore({
    environment,
    init: () => {
      calls += 1;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  assert.equal(store.evaluate("included").status, "initializing");
  assert.equal(store.evaluate("excluded").enabled, false);
  await setImmediate();
  assert.equal(calls, 1);
  resolve(client);
  await setImmediate();
  assert.equal(store.evaluate("included").status, "waiting");
  hasConfig = true;
  assert.equal(store.evaluate("included").enabled, false);
  assert.equal(store.evaluate("included").source, "cache");
  enabled = true;
  changed();
  const snapshot = store.evaluate("included");
  assert.equal(snapshot.enabled, true);
  assert.equal(store.evaluate("excluded").enabled, false);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /test-only-server-key|privateRules|must-not-leak|checkout_refresh/,
  );
  // No transport calls on evaluation; cached state survives without any network.
  for (let i = 0; i < 50; i++) assert.equal(store.evaluate("included").enabled, true);
  assert.equal(calls, 1);
  store.close();
  assert.equal(closed, true);
});

test("legitimate null flag values are cached, not treated as an empty configuration", async () => {
  const store = createEvaluationStore({
    environment,
    init: async () => ({ isEnabled: () => false, getValue: () => null, onChange() {}, close() {} }),
  });
  store.evaluate("null-value");
  await setImmediate();
  assert.equal(store.evaluate("null-value").status, "ready");
  store.close();
});

test("unexpected init rejection is sanitized and retries only after a bounded delay", async () => {
  let calls = 0;
  let now = 0;
  const store = createEvaluationStore({
    environment,
    now: () => now,
    init: async () => {
      calls += 1;
      throw new Error("sensitive-server-key");
    },
  });
  store.evaluate("retry-user");
  await setImmediate();
  const result = store.evaluate("retry-user");
  assert.equal(result.status, "sdk-error");
  assert.doesNotMatch(JSON.stringify(result), /sensitive-server-key/);
  assert.equal(calls, 1);
  now = 30_000;
  assert.equal(store.evaluate("retry-user").status, "initializing");
  await setImmediate();
  assert.equal(calls, 2);
  store.close();
});

test("closing while init is pending closes the late client", async () => {
  let resolve!: (client: EvaluationClient) => void;
  let closed = false;
  const store = createEvaluationStore({
    environment,
    init: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  store.evaluate("pending");
  await setImmediate();
  store.close();
  resolve({
    isEnabled: () => false,
    getValue: () => null,
    onChange() {},
    close() {
      closed = true;
    },
  });
  await setImmediate();
  assert.equal(closed, true);
});

test("evaluation endpoint bounds IDs, rejects duplicates, and disables HTTP caching", async () => {
  const store = createEvaluationStore({
    environment: readEnvironment({}),
    init: async () => {
      throw new Error("unused");
    },
  });
  for (const query of [
    "?userId=",
    `?userId=${"x".repeat(81)}`,
    "?userId=a&userId=b",
    "?userId=%0A",
    "?userId=%3Cscript%3E",
  ]) {
    const response = evaluateRequest(
      new Request(`http://example.test/api/evaluate${query}`),
      store.evaluate,
    );
    assert.equal(response.status, 400);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  for (const id of ["a", "x".repeat(80), "customer_1042", "person@example.test"]) {
    const response = evaluateRequest(
      new Request(`http://example.test/api/evaluate?userId=${id}`),
      store.evaluate,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).userId, id);
  }
  const response = evaluateRequest(new Request("http://example.test/api/evaluate"), store.evaluate);
  assert.equal((await response.json()).userId, DEFAULT_USER_ID);
  const failure = evaluateRequest(new Request("http://example.test/api/evaluate"), () => {
    throw new Error("private-key");
  });
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /private-key/);
  store.close();
});

test("sample checkout total reconciles to the displayed cart", () => {
  assert.equal(
    cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
    totalPaise,
  );
  assert.equal(totalPaise, 155_000);
});

test(
  "real local SDK delivers SSE changes and retains cache during an upstream outage",
  { timeout: 15_000 },
  async (t) => {
    type Client = EvaluationClient & { refresh(): Promise<void> };
    const requireFromExample = createRequire(
      new URL("../examples/next-app/package.json", import.meta.url),
    );
    const sdk: { init(options: SdkOptions): Promise<Client> } =
      requireFromExample("@flagforge/sdk");

    let enabled = false;
    let version = 1;
    let offline = false;
    let authorized = false;
    const streams = new Set<ServerResponse>();
    const server = createServer((request, response) => {
      authorized = request.headers.authorization === "Bearer test-only-server-key";
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      if (offline) {
        response.writeHead(503).end();
        return;
      }
      if (request.url === "/api/sdk/stream") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        response.write(": connected\n\n");
        streams.add(response);
        request.on("close", () => streams.delete(response));
      } else if (request.url === "/api/sdk/config") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            data: {
              environmentKey: "test",
              version,
              flags: {
                checkout_refresh: {
                  key: "checkout_refresh",
                  type: "RELEASE",
                  enabled,
                  version,
                  rules: { rules: [], defaultServe: { rolloutPercent: 100 } },
                  onValue: true,
                  offValue: false,
                },
              },
            },
          }),
        );
      } else {
        request.resume();
        response.writeHead(202).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const liveEnvironment = readEnvironment({
      FLAGFORGE_SDK_KEY: "test-only-server-key",
      FLAGFORGE_URL: `http://127.0.0.1:${address.port}`,
    });
    let client: Client | undefined;
    const store = createEvaluationStore({
      environment: liveEnvironment,
      init: async (options) => {
        client = await sdk.init(options);
        return client;
      },
    });
    t.after(async () => {
      await store.close();
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function until(predicate: () => boolean) {
      const deadline = Date.now() + 3_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "Expected SDK state within three seconds");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    assert.equal(store.evaluate(DEFAULT_USER_ID).status, "initializing");
    await until(() => store.evaluate(DEFAULT_USER_ID).status === "ready" && streams.size > 0);
    assert.equal(authorized, true);
    assert.equal(store.evaluate(DEFAULT_USER_ID).enabled, false);
    enabled = true;
    version += 1;
    for (const stream of streams) {
      stream.write(
        `event: config.changed\ndata: ${JSON.stringify({ version, changedFlagKeys: ["checkout_refresh"] })}\n\n`,
      );
    }
    await until(() => store.evaluate(DEFAULT_USER_ID).enabled);

    offline = true;
    for (const stream of streams) stream.destroy();
    await client?.refresh();
    assert.equal(store.evaluate(DEFAULT_USER_ID).enabled, true);
    assert.equal(store.evaluate("another-customer").source, "cache");

    const coldStore = createEvaluationStore({ environment: liveEnvironment, init: sdk.init });
    t.after(() => coldStore.close());
    assert.equal(coldStore.evaluate(DEFAULT_USER_ID).status, "initializing");
    await until(() => coldStore?.evaluate(DEFAULT_USER_ID).status === "waiting");
    assert.equal(coldStore.evaluate(DEFAULT_USER_ID).enabled, false);
  },
);
