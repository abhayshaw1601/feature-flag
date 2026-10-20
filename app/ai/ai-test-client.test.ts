import assert from "node:assert/strict";
import { test } from "node:test";
import { AiTestError, requestAiTest } from "./ai-test-client";

const result = {
  output: { message: "More context is needed.", insufficientData: true },
  runId: "run-test",
  model: "test-model",
  mock: true,
  promptVersion: "test-v1",
  tokensIn: 12,
  tokensOut: 8,
  latencyMs: 25,
};

test("posts only the workspace and message, uses session credentials, and validates a mock run", async (t) => {
  const controller = new AbortController();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ data: result }));

  assert.deepEqual(
    await requestAiTest("member-workspace", "Test this message", controller.signal),
    result,
  );
  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, options] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, "/api/ai/test");
  assert.equal(options.method, "POST");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.cache, "no-store");
  assert.deepEqual(options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(options.body as string), {
    workspaceId: "member-workspace",
    message: "Test this message",
  });
  assert.equal(options.signal, controller.signal);
});

test("accepts live results without coercing false or zero metadata values", async (t) => {
  const live = {
    ...result,
    output: { message: "Validated output.", insufficientData: false },
    mock: false,
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 0,
  };
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: live }));
  assert.deepEqual(await requestAiTest("member-workspace", "Test"), live);
});

test("rejects malformed output and metadata rather than rendering a partial result", async (t) => {
  const invalidBodies = [
    null,
    result,
    { data: { ...result, output: null } },
    { data: { ...result, output: { message: 123, insufficientData: false } } },
    { data: { ...result, output: { message: "Missing data status" } } },
    { data: { ...result, output: { message: "Test", insufficientData: "false" } } },
    { data: { ...result, runId: "" } },
    { data: { ...result, model: null } },
    { data: { ...result, mock: "true" } },
    { data: { ...result, promptVersion: undefined } },
    { data: { ...result, tokensIn: -1 } },
    { data: { ...result, tokensOut: 1.5 } },
    { data: { ...result, latencyMs: "25" } },
  ];
  let body: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  for (body of invalidBodies) {
    await assert.rejects(requestAiTest("member-workspace", "Test"), {
      name: "AiTestError",
      code: "INVALID_RESPONSE",
      message: "The AI service returned an unexpected response. Please try again.",
    });
  }
});

test("preserves API error code and message, including access and budget errors", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  for (const [status, code, message] of [
    [401, "UNAUTHORIZED", "Sign in to continue."],
    [403, "FORBIDDEN", "You do not belong to this workspace."],
    [429, "BUDGET_EXCEEDED", "The workspace AI budget has been reached."],
    [502, "INVALID_OUTPUT", "The model could not produce valid output."],
  ] as const) {
    fetchMock.mock.mockImplementation(async () =>
      Response.json({ error: { code, message } }, { status }),
    );
    await assert.rejects(requestAiTest("member-workspace", "Test"), (error: unknown) => {
      assert.ok(error instanceof AiTestError);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      return true;
    });
  }
});

test("non-JSON failures and malformed errors show clean fallback messages", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  for (const [status, message] of [
    [401, "Your session has expired. Sign in and try again."],
    [429, "Too many AI requests. Wait a moment before retrying."],
    [503, "The AI request failed. Please try again."],
  ] as const) {
    fetchMock.mock.mockImplementation(
      async () => new Response("<html>Proxy error</html>", { status }),
    );
    await assert.rejects(requestAiTest("member-workspace", "Test"), {
      code: "REQUEST_FAILED",
      message,
    });
  }
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ error: { code: 123, message: { internal: "details" } } }, { status: 500 }),
  );
  await assert.rejects(requestAiTest("member-workspace", "Test"), {
    code: "REQUEST_FAILED",
    message: "The AI request failed. Please try again.",
  });
});

test("non-JSON success is rejected instead of displaying raw server content", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Sign in</html>"));
  await assert.rejects(requestAiTest("member-workspace", "Test"), { code: "INVALID_RESPONSE" });
});

test("network failures do not expose transport details", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Internal transport detail");
  });
  await assert.rejects(requestAiTest("member-workspace", "Test"), {
    code: "NETWORK_ERROR",
    message: "Could not reach the AI service. Check your connection and try again.",
  });
});

test("abort remains cancellation rather than being reported as a network failure", async (t) => {
  const controller = new AbortController();
  const abortError = new DOMException("Request cancelled", "AbortError");
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort(abortError);
    throw abortError;
  });
  await assert.rejects(requestAiTest("member-workspace", "Test", controller.signal), abortError);
});

test("aborting while reading the response cannot return stale output", async (t) => {
  const controller = new AbortController();
  const response = Response.json({ data: result });
  t.mock.method(response, "json", async () => {
    controller.abort();
    return { data: result };
  });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(requestAiTest("member-workspace", "Test", controller.signal), {
    name: "AbortError",
  });
});
