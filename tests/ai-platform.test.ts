import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { getAiConfig } from "../lib/ai/config";
import { AiError } from "../lib/ai/errors";
import { createGeminiTransport, type AiTransport, type GeminiRequest } from "../lib/ai/gemini";
import { GLOBAL_AI_RULES, promptRegistry, renderAiPrompt } from "../lib/ai/prompts";
import { runAi, type AiRunStore, type RunCompletion, type RunReservation } from "../lib/ai/runner";
import { redactAiLog, sanitizeAiOutput, sanitizeAiText } from "../lib/ai/sanitize";
import { generateStructured } from "../lib/ai/structured";
import { createAiTestHandler } from "../lib/ai/test-handler";

const config = getAiConfig({ AI_MOCK: "false", GEMINI_API_KEY: "test-placeholder" });
const prompt = promptRegistry["platform-test@1"];
const valid = { message: "Ready", insufficientData: true };
const request = {
  ...renderAiPrompt(prompt, { message: "Check the platform" }),
  model: config.models.fast,
};

function fakeTransport(responses: (string | Error)[]) {
  const calls: GeminiRequest[] = [];
  const transport: AiTransport = {
    async generate(input) {
      calls.push(input);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.equal(typeof next, "string", "Unexpected extra transport call");
      return { text: next!, tokensIn: 5, tokensOut: 3 };
    },
    async *stream(input) {
      yield await transport.generate(input);
    },
  };
  return { transport, calls };
}

function fakeStore() {
  const reserved: RunReservation[] = [];
  const finished: RunCompletion[] = [];
  const store: AiRunStore = {
    async reserve(input) {
      reserved.push(input);
      return "run_test";
    },
    async finish(id, result) {
      assert.equal(id, "run_test");
      finished.push(result);
    },
  };
  return { store, reserved, finished };
}

test("Gemini-only config, selected model tiers, safe mock default, and required live key", () => {
  assert.equal(getAiConfig({}).mock, true);
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.dailyWorkspaceCallLimit, 200);
  for (const env of [
    { AI_PROVIDER: "anthropic" },
    { LLM_MODEL_FAST: "gpt-test" },
    { AI_MOCK: "yes" },
    { AI_DAILY_WORKSPACE_CALL_LIMIT: "0" },
    { AI_MOCK: "false" },
  ])
    assert.throws(() => getAiConfig(env), AiError);
  assert.equal(
    getAiConfig({ LLM_MODEL_FAST: "gemini-custom", AI_DAILY_WORKSPACE_CALL_LIMIT: "5" }).models
      .fast,
    "gemini-custom",
  );
});

test("sanitizer strips emoji sequences without stripping normal digits or punctuation", () => {
  assert.equal(
    sanitizeAiText("  Ready \u{1F680} \u{1F1EE}\u{1F1F3} \u{1F44D}\u{1F3FD}\u200D\u{1F4BB}  "),
    "Ready",
  );
  assert.equal(sanitizeAiText("1\uFE0F\u20E3 #\uFE0F\u20E3 10% * # 123"), "10% * # 123");
  assert.deepEqual(sanitizeAiOutput({ values: [" Hi \u{1F680} ", 10, null, true] }), {
    values: ["Hi", 10, null, true],
  });
});

test("log redaction removes credential fields and recognizable tokens", () => {
  assert.deepEqual(
    redactAiLog({
      apiKey: "private",
      nested: { password: "private" },
      message: "Bearer private-value",
    }),
    {
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]" },
      message: "Bearer [REDACTED]",
    },
  );
});

test("versioned prompt always contains global guardrails and treats substitutions literally", () => {
  const result = renderAiPrompt(prompt, { message: "$&" });
  assert.ok(result.system.startsWith(GLOBAL_AI_RULES));
  assert.match(result.system, /Do not use emojis/);
  assert.match(result.system, /Never invent flag keys/);
  assert.match(result.user, /\$&/);
  assert.equal(prompt.outputSchemaName, "platformTestOutputSchema");
});

test("structured output is sanitized before validation", async () => {
  const { transport, calls } = fakeTransport([
    JSON.stringify({ ...valid, message: " Ready \u{1F680} " }),
  ]);
  const result = await generateStructured({ schema: prompt.schema, request, transport });
  assert.deepEqual(result, valid);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].jsonSchema);
});

for (const [index, invalid] of [
  "not JSON",
  JSON.stringify({ message: 7 }),
  JSON.stringify({ ...valid, message: "\u{1F680}" }),
].entries()) {
  test(`invalid output receives exactly one corrective attempt: case ${index + 1}`, async () => {
    const { transport, calls } = fakeTransport([invalid, JSON.stringify(valid)]);
    assert.deepEqual(
      await generateStructured({ schema: prompt.schema, request, transport }),
      valid,
    );
    assert.equal(calls.length, 2);
    assert.match(calls[1].user, /failed validation/);
  });
}

test("two invalid outputs fail cleanly and stop", async () => {
  const { transport, calls } = fakeTransport(["{}", "{}"]);
  await assert.rejects(generateStructured({ schema: prompt.schema, request, transport }), {
    code: "AI_INVALID_OUTPUT",
  });
  assert.equal(calls.length, 2);
});

test("transport and validation share a total two-attempt ceiling", async () => {
  const { transport, calls } = fakeTransport([
    new AiError("AI_TIMEOUT", "timeout", 504, true),
    "{}",
  ]);
  await assert.rejects(generateStructured({ schema: prompt.schema, request, transport }), AiError);
  assert.equal(calls.length, 2);
});

test("transient errors retry once, permanent errors never retry", async () => {
  const retry = fakeTransport([
    new AiError("AI_PROVIDER_ERROR", "busy", 502, true),
    JSON.stringify(valid),
  ]);
  await generateStructured({ schema: prompt.schema, request, transport: retry.transport });
  assert.equal(retry.calls.length, 2);
  const fatal = fakeTransport([new AiError("AI_PROVIDER_ERROR", "bad key")]);
  await assert.rejects(
    generateStructured({ schema: prompt.schema, request, transport: fatal.transport }),
  );
  assert.equal(fatal.calls.length, 1);
});

test("mock runs validate fixtures, log safe input/output, and never call the transport", async () => {
  const state = fakeStore();
  const fake = fakeTransport([]);
  const result = await runAi({
    context: { workspaceId: "w", userId: "u" },
    prompt,
    input: { message: "raw private input" },
    logInput: { messageLength: 17 },
    config: { ...config, mock: true },
    store: state.store,
    transport: fake.transport,
  });
  assert.equal(result.mock, true);
  assert.equal(result.runId, "run_test");
  assert.equal(result.tokensIn, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(state.finished[0].status, "SUCCEEDED");
  assert.doesNotMatch(JSON.stringify(state.reserved), /raw private input/);
});

test("live run logging accounts for both invalid and corrected responses", async () => {
  const state = fakeStore();
  const { transport } = fakeTransport(["{}", JSON.stringify(valid)]);
  const result = await runAi({
    context: { workspaceId: "w", userId: "u" },
    prompt,
    input: {},
    logInput: {},
    config,
    store: state.store,
    transport,
  });
  assert.equal(result.tokensIn, 10);
  assert.equal(result.tokensOut, 6);
  assert.equal(state.finished[0].tokensIn, 10);
});

test("failed model responses record safe failures without raw output", async () => {
  const state = fakeStore();
  const { transport } = fakeTransport(["sensitive invalid data", "sensitive invalid data"]);
  await assert.rejects(
    runAi({
      context: { workspaceId: "w", userId: "u" },
      prompt,
      input: {},
      logInput: {},
      config,
      store: state.store,
      transport,
    }),
    { code: "AI_INVALID_OUTPUT" },
  );
  assert.equal(state.finished[0].status, "FAILED");
  assert.equal(state.finished[0].tokensIn, 10);
  assert.doesNotMatch(JSON.stringify(state.finished), /sensitive/);
});

test("a denied reservation makes no model call and cannot be bypassed with mock mode", async () => {
  for (const mock of [true, false]) {
    const { transport, calls } = fakeTransport([]);
    const store: AiRunStore = {
      async reserve() {
        throw new AiError("AI_RATE_LIMIT", "limited", 429);
      },
      async finish() {
        assert.fail();
      },
    };
    await assert.rejects(
      runAi({
        context: { workspaceId: "w", userId: "u" },
        prompt,
        input: {},
        logInput: {},
        config: { ...config, mock },
        store,
        transport,
      }),
      { code: "AI_RATE_LIMIT" },
    );
    assert.equal(calls.length, 0);
  }
});

const envelope = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, thoughtsTokenCount: 2 },
});

test("Gemini wire request uses private headers, structured schema, system instruction and selected model", async () => {
  const transport = createGeminiTransport(config, async (url, init) => {
    assert.match(String(url), /models\/gemini-2.5-flash:generateContent$/);
    assert.doesNotMatch(String(url), /test-placeholder/);
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-placeholder");
    const body = JSON.parse(init?.body as string);
    assert.match(body.systemInstruction.parts[0].text, /Do not use emojis/);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.responseJsonSchema.type, "object");
    return Response.json(envelope(JSON.stringify(valid)));
  });
  const result = await transport.generate({ ...request, jsonSchema: { type: "object" } });
  assert.equal(result.tokensIn, 10);
  assert.equal(result.tokensOut, 10);
});

test("streaming parser survives split UTF-8 and CRLF frames; structured results validate at end", async () => {
  const first = { candidates: [{ content: { parts: [{ text: '{"message":"Caf\u00e9",' }] } }] };
  const last = envelope('"insufficientData":true}');
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify(first)}\r\n\r\ndata: ${JSON.stringify(last)}\r\n\r\n`,
  );
  const transport = createGeminiTransport(config, async (url) => {
    assert.match(String(url), /streamGenerateContent\?alt=sse$/);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
  });
  const progress: number[] = [];
  const result = await generateStructured({
    schema: prompt.schema,
    request,
    transport,
    streaming: true,
    onProgress: (count) => progress.push(count),
  });
  assert.deepEqual(result, { message: "Caf\u00e9", insufficientData: true });
  assert.equal(progress.length, 2);
  assert.ok(progress[1] > progress[0]);
});

test("timeout aborts the real fetch signal, cancellation is distinct", async () => {
  const fetcher: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const transport = createGeminiTransport({ ...config, timeoutMs: 10 }, fetcher);
  await assert.rejects(transport.generate({ ...request, jsonSchema: {} }), {
    code: "AI_TIMEOUT",
    retryable: true,
  });
  const controller = new AbortController();
  const pending = transport.generate({ ...request, jsonSchema: {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "AI_CANCELLED", retryable: false });
});

test("provider errors never expose the raw response body", async () => {
  const transport = createGeminiTransport(
    config,
    async () => new Response("private provider diagnostic", { status: 401 }),
  );
  await assert.rejects(transport.generate({ ...request, jsonSchema: {} }), (error: unknown) => {
    assert.ok(error instanceof AiError);
    assert.doesNotMatch(error.message, /private/);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("safety blocks and truncated generations are never accepted as successful JSON", async () => {
  for (const data of [
    { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [{ ...envelope("{}").candidates[0], finishReason: "MAX_TOKENS" }] },
  ]) {
    const transport = createGeminiTransport(config, async () => Response.json(data));
    await assert.rejects(transport.generate({ ...request, jsonSchema: {} }), {
      code: "AI_INCOMPLETE_OUTPUT",
    });
  }
});

function httpRequest(
  body: unknown = { workspaceId: "w", message: "Check" },
  headers: HeadersInit = {},
) {
  return new Request("http://localhost:3000/api/ai/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("HTTP handler derives identity from authorization, returns validated result metadata", async () => {
  const state = fakeStore();
  const handler = createAiTestHandler({
    async authorize(workspaceId) {
      assert.equal(workspaceId, "w");
      return { userId: "authenticated" };
    },
    run(input, userId, signal) {
      assert.equal(userId, "authenticated");
      return runAi({
        context: { workspaceId: input.workspaceId, userId },
        prompt,
        input,
        logInput: {},
        config: { ...config, mock: true },
        store: state.store,
        signal,
      });
    },
  });
  const response = await handler(httpRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  prompt.schema.parse(body.data.output);
  assert.equal(body.data.runId, "run_test");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("HTTP rejects malformed/oversized/untrusted requests before execution", async () => {
  const handler = createAiTestHandler({
    async authorize() {
      assert.fail("must not authorize invalid payload");
    },
    async run() {
      assert.fail();
    },
  });
  for (const [request, expected] of [
    [httpRequest({ workspaceId: "w", message: "Check", userId: "spoof" }), 400],
    [httpRequest({ workspaceId: "w", message: " " }), 400],
    [httpRequest({ workspaceId: "w", message: "x".repeat(20001) }), 413],
    [httpRequest(undefined, { origin: "https://untrusted.invalid" }), 403],
    [httpRequest(undefined, { "content-type": "text/plain" }), 415],
    [
      new Request("http://localhost:3000/api/ai/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      400,
    ],
  ] as const)
    assert.equal((await handler(request)).status, expected);
});

test("HTTP authorization, safe errors, and Retry-After survive the boundary", async () => {
  for (const [error, expected] of [
    [new AiError("AUTHORIZATION_REQUIRED", "Sign in.", 401), 401],
    [new AiError("AI_FORBIDDEN", "Forbidden.", 403), 403],
    [new AiError("AI_RATE_LIMIT", "Wait.", 429, false, 60), 429],
    [new Error("secret database URL"), 503],
  ] as const) {
    const handler = createAiTestHandler({
      async authorize() {
        throw error;
      },
      async run() {
        assert.fail();
      },
    });
    const response = await handler(httpRequest());
    assert.equal(response.status, expected);
    if (expected === 429) assert.equal(response.headers.get("retry-after"), "60");
    assert.doesNotMatch(await response.text(), /secret database/);
  }
});

test("every feature supplies a Zod schema, including custom schemas", async () => {
  const schema = z.object({ percent: z.number().int().min(0).max(100) });
  const { transport } = fakeTransport(['{"percent":200}', '{"percent":10}']);
  assert.deepEqual(await generateStructured({ schema, transport, request }), { percent: 10 });
});

test("an SSE response without a terminal STOP is rejected even when its JSON parses", async () => {
  const data = { candidates: [{ content: { parts: [{ text: JSON.stringify(valid) }] } }] };
  const transport = createGeminiTransport(
    config,
    async () => new Response(`data: ${JSON.stringify(data)}\n\n`),
  );
  await assert.rejects(
    async () => {
      for await (const chunk of transport.stream({ ...request, jsonSchema: {} })) void chunk;
    },
    { code: "AI_TRUNCATED_STREAM" },
  );
});

test("emoji-bearing dictionary keys fail instead of silently changing semantic identifiers", () => {
  assert.throws(() => sanitizeAiOutput({ ["name\u{1F680}"]: "value" }), {
    code: "AI_INVALID_OUTPUT",
  });
});

test("pre-cancelled runs are recorded as cancelled without a provider call", async () => {
  const state = fakeStore();
  const { transport, calls } = fakeTransport([]);
  await assert.rejects(
    runAi({
      context: { workspaceId: "w", userId: "u" },
      prompt,
      input: {},
      logInput: {},
      config,
      store: state.store,
      transport,
      signal: AbortSignal.abort(),
    }),
    { code: "AI_CANCELLED" },
  );
  assert.equal(calls.length, 0);
  assert.equal(state.finished[0].error, "AI_CANCELLED");
});

test("a logging failure cannot return an unrecorded successful response", async () => {
  const store: AiRunStore = {
    async reserve() {
      return "run_test";
    },
    async finish() {
      throw new Error("database unavailable");
    },
  };
  await assert.rejects(
    runAi({
      context: { workspaceId: "w", userId: "u" },
      prompt,
      input: {},
      logInput: {},
      config: { ...config, mock: true },
      store,
    }),
  );
});
