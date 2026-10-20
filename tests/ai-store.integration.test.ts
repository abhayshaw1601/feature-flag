import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { getAiConfig } from "../lib/ai/config";
import { promptRegistry } from "../lib/ai/prompts";
import { runAi } from "../lib/ai/runner";
import { createPrismaAiRunStore } from "../lib/ai/store";

const databaseUrl = process.env.AI_TEST_DATABASE_URL;

test("PostgreSQL atomic AI admission and persisted runs", { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl!);
  assert.ok(
    ["localhost", "127.0.0.1"].includes(url.hostname),
    "Only a disposable local test database is allowed",
  );
  assert.equal(
    url.pathname,
    "/flagforge_ai_test",
    "Never run this suite against an application database",
  );
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const otherInstance = new PrismaClient({ datasourceUrl: databaseUrl });
  const store = createPrismaAiRunStore(db);
  const otherStore = createPrismaAiRunStore(otherInstance);
  const workspaces: string[] = [];
  const users: string[] = [];
  async function fixture() {
    const user = await db.user.create({ data: { name: "AI integration test" } });
    users.push(user.id);
    const workspace = await db.workspace.create({
      data: {
        name: "AI integration test",
        slug: `ai-test-${randomUUID()}`,
        members: { create: { userId: user.id, role: "VIEWER" } },
      },
    });
    workspaces.push(workspace.id);
    return {
      workspaceId: workspace.id,
      userId: user.id,
      feature: "PLATFORM_TEST",
      model: "gemini-2.5-flash",
      input: { test: true },
      dailyLimit: 200,
    };
  }
  try {
    await t.test("25 concurrent requests across instances admit exactly 20 per user", async () => {
      const input = await fixture();
      const results = await Promise.allSettled(
        Array.from({ length: 25 }, (_, i) => (i % 2 ? store : otherStore).reserve(input)),
      );
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 20);
      const failures = results.filter((result) => result.status === "rejected");
      assert.equal(failures.length, 5);
      for (const failure of failures) assert.equal(failure.reason.code, "AI_RATE_LIMIT");
      assert.equal(await db.aiRun.count({ where: { userId: input.userId } }), 20);
      // The user cannot evade the limit by choosing another workspace.
      const second = await fixture();
      await db.member.create({
        data: { userId: input.userId, workspaceId: second.workspaceId, role: "VIEWER" },
      });
      await assert.rejects(store.reserve({ ...second, userId: input.userId }), {
        code: "AI_RATE_LIMIT",
      });
      // Rows older than a rolling minute no longer prevent admission.
      await db.aiRun.updateMany({
        where: { userId: input.userId },
        data: { createdAt: new Date(Date.now() - 61000) },
      });
      await store.reserve(input);
    });

    await t.test("concurrent users share an atomic workspace daily budget", async () => {
      const input = { ...(await fixture()), dailyLimit: 3 };
      const second = await fixture();
      await db.member.create({
        data: { userId: second.userId, workspaceId: input.workspaceId, role: "VIEWER" },
      });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? store : otherStore).reserve({
            ...input,
            userId: i % 2 ? input.userId : second.userId,
          }),
        ),
      );
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
      for (const result of results)
        if (result.status === "rejected") {
          assert.equal(result.reason.code, "AI_DAILY_BUDGET");
          assert.ok(result.reason.retryAfter > 0 && result.reason.retryAfter <= 86400);
        }
      // Yesterday's runs do not count toward today's budget.
      await db.aiRun.updateMany({
        where: { workspaceId: input.workspaceId },
        data: { createdAt: new Date(Date.now() - 86400000) },
      });
      await store.reserve(input);
    });

    await t.test("nonmembers cannot reserve or log calls in another workspace", async () => {
      const input = await fixture();
      const other = await fixture();
      await assert.rejects(store.reserve({ ...input, userId: other.userId }), {
        code: "AI_FORBIDDEN",
      });
      assert.equal(await db.aiRun.count({ where: { workspaceId: input.workspaceId } }), 0);
    });

    await t.test(
      "mock success and live failure persist readable rows with safe usage metadata",
      async () => {
        const input = await fixture();
        const prompt = promptRegistry["platform-test@1"];
        const options = {
          context: input,
          prompt,
          input: { message: "Check" },
          logInput: { messageLength: 5 },
          config: getAiConfig({ AI_MOCK: "true" }),
          store,
        };
        const result = await runAi(options);
        const row = await db.aiRun.findUniqueOrThrow({ where: { id: result.runId } });
        assert.equal(row.status, "SUCCEEDED");
        assert.equal(row.userId, input.userId);
        assert.deepEqual(row.output, prompt.fixture);
        assert.equal(row.tokensIn, 0);
        assert.ok(row.latencyMs >= 0);
        await assert.rejects(
          runAi({
            ...options,
            config: { ...options.config, mock: false },
            transport: {
              async generate() {
                return { text: "{}", tokensIn: 10, tokensOut: 1 };
              },
              async *stream() {
                throw new Error("unused");
              },
            },
          }),
          { code: "AI_INVALID_OUTPUT" },
        );
        const failed = await db.aiRun.findFirstOrThrow({
          where: { workspaceId: input.workspaceId, status: "FAILED" },
        });
        assert.equal(failed.tokensIn, 20);
        assert.equal(failed.tokensOut, 2);
        assert.equal(failed.error, "AI_INVALID_OUTPUT");
        assert.equal(failed.output, null);
      },
    );
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await Promise.all([db.$disconnect(), otherInstance.$disconnect()]);
  }
});
