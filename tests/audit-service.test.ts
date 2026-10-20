import assert from "node:assert/strict";
import test from "node:test";
import { createAuditService, AuditAccessError, type AuditDependencies } from "../lib/audit/service";
import { createAuditHttpHandlers } from "../lib/audit/http";
import { demoAuditRows, demoAuditNow, filterDemoAudit } from "../lib/audit/demo";
import { parseAuditFilters } from "../lib/audit/query";
import { auditWhere, redactAuditSnapshot } from "../lib/audit/repository";
import { queueCreatedFlagSummary } from "../lib/audit/after-write";
import { AiError } from "../lib/ai/errors";

function setup(overrides: Partial<AuditDependencies> = {}) {
  const calls: string[] = [];
  const rows = demoAuditRows.slice(0, 2);
  const deps: AuditDependencies = {
    now: () => new Date(demoAuditNow),
    getUserId: async () => "user_a",
    authorize: async (workspace, user, write) => {
      calls.push(`auth:${workspace}:${user}:${write}`);
    },
    read: async (query) => {
      calls.push(`read:${query.workspaceId}`);
      return { items: rows, digestRows: rows, total: rows.length };
    },
    findEvents: async (workspace, ids) => {
      calls.push(`find:${workspace}`);
      return rows.filter((row) => ids.includes(row.id));
    },
    generate: async (input) => {
      calls.push("generate");
      return {
        output: { summaries: input.map((row) => ({ eventId: row.id, summary: row.summary })) },
        model: "gemini-2.5-flash",
        mock: true,
      };
    },
    persist: async (_workspace, _user, input) => {
      calls.push("persist");
      return input.length;
    },
    ...overrides,
  };
  const service = createAuditService(deps);
  return { service, handlers: createAuditHttpHandlers(service), calls, rows };
}
const post = (body: unknown, headers: HeadersInit = {}) =>
  new Request("http://localhost/api/ai/audit-summary", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("overview uses authorized workspace scope and never waits on the model", async () => {
  const { service, calls } = setup();
  const result = await service.overview({ workspaceId: "ws_a" });
  assert.equal(result.items.length, 2);
  assert.equal(result.digest.eventCount, 2);
  assert.deepEqual(calls, ["auth:ws_a:user_a:false", "read:ws_a"]);
});
test("unauthenticated reads and writes never query audit data", async () => {
  const { handlers, calls } = setup({ getUserId: async () => null });
  assert.equal(
    (await handlers.GET(new Request("http://localhost/api/audit/overview?workspaceId=ws_a")))
      .status,
    401,
  );
  assert.equal((await handlers.POST(post({ workspaceId: "ws_a", eventIds: ["x"] }))).status, 401);
  assert.deepEqual(calls, []);
});
test("foreign membership and viewer writes are denied before lookup or AI spend", async () => {
  const { service, calls } = setup({
    authorize: async () => {
      throw new AuditAccessError(403, "FORBIDDEN", "Not allowed.");
    },
  });
  await assert.rejects(service.overview({ workspaceId: "foreign" }), { status: 403 });
  await assert.rejects(service.summarize({ workspaceId: "foreign", eventIds: ["x"] }), {
    status: 403,
  });
  assert.deepEqual(calls, []);
});
test("a mixed or missing event ID batch cannot reach generation", async () => {
  const { service, calls, rows } = setup();
  await assert.rejects(
    service.summarize({ workspaceId: "ws_a", eventIds: [rows[0].id, "foreign"] }),
    { status: 404 },
  );
  assert.deepEqual(calls, ["auth:ws_a:user_a:true", "find:ws_a"]);
});
test("valid batches recheck access and persist generated summaries", async () => {
  const { service, calls, rows } = setup();
  const result = await service.summarize({
    workspaceId: "ws_a",
    eventIds: rows.map((row) => row.id),
  });
  assert.deepEqual(result, { updated: 2, model: "gemini-2.5-flash", mock: true });
  assert.deepEqual(calls, [
    "auth:ws_a:user_a:true",
    "find:ws_a",
    "generate",
    "auth:ws_a:user_a:true",
    "persist",
  ]);
});
test("already cached batches use no provider call", async () => {
  const { service, calls } = setup({
    findEvents: async () => [
      { ...demoAuditRows[0], summarySource: "mock", summaryModel: "gemini-2.5-flash" },
    ],
  });
  assert.equal(
    (await service.summarize({ workspaceId: "ws_a", eventIds: [demoAuditRows[0].id] })).updated,
    0,
  );
  assert.deepEqual(calls, ["auth:ws_a:user_a:true"]);
});
test("revoked membership after provider completion prevents cache publication", async () => {
  let checks = 0;
  const { service, calls, rows } = setup({
    authorize: async () => {
      if (++checks === 2) throw new AuditAccessError(403, "FORBIDDEN", "Access was revoked.");
    },
  });
  await assert.rejects(service.summarize({ workspaceId: "ws_a", eventIds: [rows[0].id] }), {
    status: 403,
  });
  assert.ok(!calls.includes("persist"));
});
test("query validation rejects unknown/repeated filters, reversed dates, and invalid paging", () => {
  for (const input of [
    new URLSearchParams("workspaceId=w&workspaceId=x"),
    { workspaceId: "w", other: "value" },
    { workspaceId: "w", from: "2026-10-20T00:00:00Z", to: "2026-10-19T00:00:00Z" },
    { workspaceId: "w", page: 0 },
  ])
    assert.throws(() => parseAuditFilters(input));
});
test("repository predicates never drop workspace scoping when other filters are supplied", () => {
  const where = auditWhere(
    parseAuditFilters(
      {
        workspaceId: "w",
        projectId: "foreign",
        flagId: "f",
        actorId: "a",
        environmentId: "e",
        range: "7d",
      },
      new Date(demoAuditNow),
    ),
  );
  assert.deepEqual(where.project, { workspaceId: "w" });
  assert.equal(where.projectId, "foreign");
  assert.equal(where.flagId, "f");
  assert.equal(where.actorId, "a");
  assert.equal(where.environmentId, "e");
});
test("demo filter and pagination share the digest scope", () => {
  const filtered = filterDemoAudit({
    range: "7d",
    projectId: "demo_api",
    actorId: "demo_priya",
    page: 1,
  });
  assert.equal(filtered.items.length, 10);
  assert.ok(
    filtered.items.every((row) => row.projectId === "demo_api" && row.actor?.id === "demo_priya"),
  );
  assert.equal(filtered.digest.eventCount, filtered.pagination.total);
  assert.equal(filterDemoAudit({ range: "7d", page: 2 }).items.length, 25);
});
test("raw diffs redact credentials but preserve exact ordinary values", () => {
  const snapshot = {
    rawKey: "private",
    nested: { password: "private", name: "  Pro plan  ", rolloutPercent: 10 },
  };
  assert.deepEqual(redactAuditSnapshot(snapshot), {
    rawKey: "[REDACTED]",
    nested: { password: "[REDACTED]", name: "  Pro plan  ", rolloutPercent: 10 },
  });
  assert.equal(snapshot.rawKey, "private");
});
test("HTTP boundaries reject cross-origin, non-JSON, oversized and duplicate-ID writes", async () => {
  const { handlers, calls } = setup();
  assert.equal((await handlers.POST(post({}, { origin: "https://foreign.example" }))).status, 403);
  assert.equal((await handlers.POST(post({}, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handlers.POST(post({ payload: "x".repeat(9000) }))).status, 413);
  assert.equal((await handlers.POST(post({ workspaceId: "w", eventIds: ["a", "a"] }))).status, 400);
  assert.deepEqual(calls, []);
});
test("safe AI errors preserve retry advice; internal errors expose no payload", async () => {
  const { handlers, rows } = setup({
    generate: async () => {
      throw new AiError("AI_RATE_LIMIT", "Try again.", 429, false, 60);
    },
  });
  const response = await handlers.POST(post({ workspaceId: "w", eventIds: [rows[0].id] }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  const failing = setup({
    read: async () => {
      throw new Error("private database payload");
    },
  });
  const result = await failing.handlers.GET(
    new Request("http://localhost/api/audit/overview?workspaceId=w"),
  );
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /private/);
});
test("after-write scheduling preserves successful responses even when enrichment fails", async () => {
  const tasks: Array<() => Promise<void>> = [];
  const response = Response.json({ data: { id: "flag_a" } }, { status: 201 });
  await queueCreatedFlagSummary(response, {
    getUserId: async () => "user_a",
    schedule: (task) => tasks.push(task),
    enrich: async (flagId, userId) => {
      assert.equal(flagId, "flag_a");
      assert.equal(userId, "user_a");
      throw new Error("provider unavailable");
    },
  });
  assert.equal(tasks.length, 1);
  await tasks[0]();
  assert.equal((await response.json()).data.id, "flag_a");
});
test("failed writes never schedule enrichment", async () => {
  await queueCreatedFlagSummary(Response.json({}, { status: 409 }), {
    getUserId: async () => {
      throw new Error("must not authenticate");
    },
    schedule: () => assert.fail("must not schedule"),
    enrich: async () => assert.fail("must not generate"),
  });
});
