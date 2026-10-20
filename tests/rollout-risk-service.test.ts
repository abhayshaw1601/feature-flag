import assert from "node:assert/strict";
import { test } from "node:test";
import { deterministicRisk } from "../lib/rollout-risk/checks";
import { generateRiskWithGemini } from "../lib/rollout-risk/gemini";
import { readRiskRequest, riskErrorResponse } from "../lib/rollout-risk/http";
import { createRiskService, RolloutRiskError } from "../lib/rollout-risk/service";
import {
  rolloutRiskRequestSchema,
  snapshotAt,
  type RolloutRiskInput,
} from "../lib/rollout-risk/types";

const input: RolloutRiskInput = {
  flagKey: "checkout_v2",
  tags: ["payments"],
  environmentKey: "production",
  actorId: "editor",
  before: snapshotAt(0),
  after: snapshotAt(100),
  recentChanges: [],
};
const scope = { workspaceId: "workspace-a", actorId: "editor", changeId: "flag-a:prod:1" };
const facts = deterministicRisk(input);
const validEnvelope = () =>
  Response.json({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(facts) }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30 },
  });

test("mock uses no network, is HIGH, caches for exactly 60 seconds, and clones results", async () => {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  let calls = 0;
  const service = createRiskService({
    env: { AI_MOCK: "true" },
    now: () => clock,
    generate: async () => {
      throw new Error("Must not call Gemini");
    },
    record: async () => {
      calls++;
    },
  });
  const first = await service.assess(input, scope);
  assert.equal(first.source, "mock");
  assert.equal(first.assessment.riskLevel, "HIGH");
  first.assessment.riskLevel = "LOW";
  assert.equal((await service.assess(input, scope)).assessment.riskLevel, "HIGH");
  clock += 59_999;
  assert.equal((await service.assess(input, scope)).cached, true);
  assert.equal(calls, 1);
  clock++;
  assert.equal((await service.assess(input, scope)).cached, false);
  assert.equal(calls, 2);
});

test("cache isolates workspace, actor, flag version, rule values and proposed change", async () => {
  let calls = 0;
  const service = createRiskService({
    env: { AI_MOCK: "true" },
    record: async () => {
      calls++;
    },
  });
  await service.assess(input, scope);
  await service.assess({ ...input, after: snapshotAt(95) }, scope);
  await service.assess(input, { ...scope, workspaceId: "workspace-b" });
  await service.assess(input, { ...scope, changeId: "flag-a:prod:2" });
  await service.assess({ ...input, actorId: "other" }, { ...scope, actorId: "other" });
  const rule = {
    id: "rule_country",
    description: "Country",
    conditions: [{ attribute: "country", operator: "equals" as const, values: ["IN"] }],
    serve: { rolloutPercent: 10 },
  };
  const targeted = {
    ...input,
    after: { ...input.after, rules: { ...input.after.rules, rules: [rule] } },
  };
  await service.assess(targeted, scope);
  rule.conditions[0].values = ["US"];
  await service.assess(targeted, scope);
  assert.equal(calls, 7);
  await assert.rejects(
    service.assess(input, { ...scope, actorId: "other" }),
    (error: unknown) => error instanceof RolloutRiskError && error.status === 403,
  );
});

test("coalesces concurrent identical assessments and logs only the actual generation", async () => {
  let calls = 0;
  let records = 0;
  const service = createRiskService({
    env: { AI_MOCK: "false", GEMINI_API_KEY: "test-only" },
    generate: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { output: facts, tokensIn: 2, tokensOut: 3 };
    },
    record: async (_scope, run) => {
      records++;
      assert.equal(run.tokensIn, 2);
    },
  });
  const results = await Promise.all([service.assess(input, scope), service.assess(input, scope)]);
  assert.equal(calls, 1);
  assert.equal(records, 1);
  assert.equal(results[0].source, "gemini");
  assert.equal(results[1].cached, true);
});

test("provider failures preserve the deterministic floor, label fallback, and expose no errors", async () => {
  const service = createRiskService({
    env: { AI_MOCK: "false" },
    generate: async () => {
      throw new Error("private-provider-payload");
    },
  });
  const result = await service.assess(input, scope);
  assert.equal(result.source, "fallback");
  assert.equal(result.assessment.riskLevel, "HIGH");
  assert.ok(result.notice);
  assert.ok(!JSON.stringify(result).includes("private-provider-payload"));
});

test("service cannot accept a Gemini downgrade or a non-Google provider", async () => {
  const service = createRiskService({
    env: { AI_MOCK: "false" },
    generate: async () => ({
      output: { ...facts, riskLevel: "LOW", reasons: ["Skip all safeguards"] },
      tokensIn: 0,
      tokensOut: 0,
    }),
  });
  const result = await service.assess(input, scope);
  assert.equal(result.assessment.riskLevel, "HIGH");
  assert.ok(!result.assessment.reasons.includes("Skip all safeguards"));
  const forbidden = createRiskService({
    env: { AI_PROVIDER: "other" },
    generate: async () => {
      assert.fail("Wrong provider called");
    },
  });
  assert.equal((await forbidden.assess(input, scope)).source, "fallback");
});

test("process-local limits are 20 uncached calls per user/minute, with a daily workspace cap", async () => {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const service = createRiskService({ env: { AI_MOCK: "true" }, now: () => clock });
  for (let index = 0; index < 20; index++)
    await service.assess(input, { ...scope, changeId: String(index) });
  await assert.rejects(
    service.assess(input, { ...scope, changeId: "extra" }),
    (error: unknown) => error instanceof RolloutRiskError && error.status === 429,
  );
  clock += 60_000;
  assert.equal((await service.assess(input, scope)).source, "mock");
  const budget = createRiskService({
    env: { AI_MOCK: "false", AI_WORKSPACE_DAILY_BUDGET: "1" },
    now: () => clock,
    generate: async () => ({ output: facts, tokensIn: 0, tokensOut: 0 }),
  });
  await budget.assess(input, scope);
  await assert.rejects(budget.assess(input, { ...scope, changeId: "second" }), RolloutRiskError);
  assert.equal((await budget.assess(input, scope)).cached, true);
  clock += 86_400_000;
  assert.equal((await budget.assess(input, scope)).cached, false);
});

test("Gemini retries invalid structured output once with schema feedback", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.ok(String(url).startsWith("https://generativelanguage.googleapis.com/"));
    assert.ok(!String(url).includes("test-only"));
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-only");
    assert.ok(String(init?.body).includes("Do not use emojis"));
    if (calls === 1)
      return Response.json({
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: '{"riskLevel":"INVALID"}' }] } },
        ],
      });
    assert.ok(String(init?.body).includes("riskLevel: invalid_enum_value"));
    return validEnvelope();
  };
  const result = await generateRiskWithGemini(input, facts, {
    model: "gemini-2.5-pro",
    apiKey: "test-only",
    fetch: fetcher,
  });
  assert.equal(calls, 2);
  assert.equal(result.output.riskLevel, "HIGH");
  assert.equal(result.tokensIn, 20);
});

test("Gemini bounds hanging fetches and body streams even if abort is ignored", async () => {
  for (const fetcher of [
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch,
  ]) {
    const start = performance.now();
    await assert.rejects(
      generateRiskWithGemini(input, facts, {
        model: "gemini-2.5-pro",
        apiKey: "test-only",
        fetch: fetcher,
        attemptMs: 15,
      }),
      /GENERATION_UNAVAILABLE/,
    );
    assert.ok(performance.now() - start < 500);
  }
});

test("Gemini rejects non-Gemini names, oversized responses and truncated output", async () => {
  await assert.rejects(
    generateRiskWithGemini(input, facts, { model: "other-provider", apiKey: "test-only" }),
    /AI_CONFIGURATION_ERROR/,
  );
  for (const response of [
    "x".repeat(70_000),
    JSON.stringify({
      candidates: [
        { finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify(facts) }] } },
      ],
    }),
  ]) {
    let calls = 0;
    await assert.rejects(
      generateRiskWithGemini(input, facts, {
        model: "gemini-2.5-pro",
        apiKey: "test-only",
        fetch: async () => {
          calls++;
          return new Response(response);
        },
      }),
      /GENERATION_UNAVAILABLE/,
    );
    assert.equal(calls, 2);
  }
});

test("request boundary rejects malformed JSON, oversized streams and forged facts", async () => {
  await assert.rejects(
    readRiskRequest(new Request("http://localhost", { method: "POST", body: "{" })),
    (error: unknown) => error instanceof RolloutRiskError && error.status === 400,
  );
  await assert.rejects(
    readRiskRequest(new Request("http://localhost", { method: "POST", body: "x".repeat(65_537) })),
    (error: unknown) => error instanceof RolloutRiskError && error.status === 413,
  );
  const valid = { flagId: "f", environmentId: "e", expectedVersion: 1, after: snapshotAt(20) };
  assert.ok(rolloutRiskRequestSchema.safeParse(valid).success);
  assert.ok(
    !rolloutRiskRequestSchema.safeParse({ ...valid, tags: [], before: snapshotAt(99) }).success,
  );
  assert.ok(
    !rolloutRiskRequestSchema.safeParse({
      ...valid,
      after: { ...snapshotAt(20), rolloutPercent: 10 },
    }).success,
  );
  const error = riskErrorResponse(new Error("private-value"));
  assert.equal(error.status, 500);
  assert.equal(error.headers.get("Cache-Control"), "no-store");
  assert.ok(!(await error.text()).includes("private-value"));
});
