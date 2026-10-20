import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createAuditRepository, loadAuditOptions } from "../lib/audit/repository";
import { createAuditService } from "../lib/audit/service";
import { generateAuditSummaries } from "../lib/audit/generate";
import { getAiConfig } from "../lib/ai/config";
import { createPrismaAiRunStore } from "../lib/ai/store";

const url = process.env.AUDIT_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/flagforge_audit_test"
  ) {
    throw new Error(
      "Audit integration tests require the disposable local flagforge_audit_test database.",
    );
  }
  const socket = parsed.searchParams.get("host");
  if (socket && socket !== "/var/run/postgresql")
    throw new Error("Only the local PostgreSQL socket is allowed.");
}

test(
  "PostgreSQL summary caching, read-back, tenant/role isolation, and immediate fallback",
  { skip: !url },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const prefix = `audit_it_${randomUUID().replaceAll("-", "")}`;
    const workspaces = [`${prefix}_a`, `${prefix}_b`];
    const users = [`${prefix}_editor`, `${prefix}_viewer`, `${prefix}_outsider`];
    try {
      await db.user.createMany({
        data: users.map((id) => ({
          id,
          githubId: id,
          name: id.endsWith("editor") ? "Priya" : "Test user",
        })),
      });
      await db.workspace.createMany({
        data: workspaces.map((id) => ({ id, name: "Audit test workspace", slug: id })),
      });
      await db.member.createMany({
        data: [
          { workspaceId: workspaces[0], userId: users[0], role: "EDITOR" },
          { workspaceId: workspaces[0], userId: users[1], role: "VIEWER" },
          { workspaceId: workspaces[1], userId: users[2], role: "OWNER" },
        ],
      });
      const project = await db.project.create({
        data: { workspaceId: workspaces[0], key: "web", name: "Storefront" },
      });
      const foreignProject = await db.project.create({
        data: { workspaceId: workspaces[1], key: "private", name: "Foreign project" },
      });
      const environment = await db.environment.create({
        data: { projectId: project.id, key: "production", name: "Production" },
      });
      const flag = await db.flag.create({
        data: { projectId: project.id, key: "checkout_v2", name: "Checkout v2", type: "RELEASE" },
      });
      const started = performance.now();
      const event = await db.auditEvent.create({
        data: {
          projectId: project.id,
          flagId: flag.id,
          environmentId: environment.id,
          actorId: users[0],
          actorName: "Priya",
          action: "FLAG_UPDATED",
          before: { rolloutPercent: 10, enabled: true },
          after: { rolloutPercent: 50, enabled: true, rawKey: "synthetic-secret-do-not-export" },
          summary: "A change was recorded.",
        },
      });
      const foreign = await db.auditEvent.create({
        data: {
          projectId: foreignProject.id,
          actorId: users[2],
          action: "FLAG_CREATED",
          summary: "Foreign event.",
        },
      });
      let identity = users[0];
      const repository = createAuditRepository(db);
      const service = createAuditService({
        ...repository,
        getUserId: async () => identity,
        generate: (rows, context, signal) =>
          generateAuditSummaries(rows, {
            context,
            signal,
            config: getAiConfig({ AI_MOCK: "true" }),
            store: createPrismaAiRunStore(db),
          }),
      });
      const before = await service.overview({ workspaceId: workspaces[0] });
      const elapsed = performance.now() - started;
      assert.equal(before.items.length, 1);
      assert.match(before.items[0].summary, /10% to 50%/);
      assert.equal(before.items[0].summarySource, "fallback");
      assert.ok(elapsed < 5000, `Immediate fallback took ${elapsed.toFixed(0)}ms`);
      assert.doesNotMatch(JSON.stringify(before), /synthetic-secret-do-not-export|Foreign event/);
      console.log(
        `Audit fallback read-back: ${elapsed.toFixed(0)}ms (local PostgreSQL, no provider call).`,
      );

      const result = await service.summarize({ workspaceId: workspaces[0], eventIds: [event.id] });
      assert.equal(result.updated, 1);
      assert.equal(result.mock, true);
      const stored = await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
      assert.equal(stored.summarySource, "mock");
      assert.equal(stored.summaryVersion, "1");
      assert.ok(stored.summarizedAt);
      assert.match(stored.summary, /10% to 50%/);
      assert.equal(
        (await service.overview({ workspaceId: workspaces[0] })).items[0].summarySource,
        "mock",
      );
      assert.equal(
        await db.aiRun.count({ where: { workspaceId: workspaces[0], feature: "AUDIT_SUMMARY" } }),
        1,
      );
      assert.equal(
        (await service.summarize({ workspaceId: workspaces[0], eventIds: [event.id] })).updated,
        0,
      );
      assert.equal(await db.aiRun.count({ where: { workspaceId: workspaces[0] } }), 1);
      assert.equal((await loadAuditOptions(db, workspaces[0])).projects.length, 1);
      await assert.rejects(
        service.summarize({ workspaceId: workspaces[0], eventIds: [event.id, foreign.id] }),
        { status: 404 },
      );
      assert.equal(
        (await service.overview({ workspaceId: workspaces[0], projectId: foreignProject.id })).items
          .length,
        0,
      );
      identity = users[1];
      assert.equal((await service.overview({ workspaceId: workspaces[0] })).items.length, 1);
      await assert.rejects(
        service.summarize({ workspaceId: workspaces[0], eventIds: [event.id] }),
        { status: 403 },
      );
      identity = users[2];
      await assert.rejects(service.overview({ workspaceId: workspaces[0] }), { status: 403 });
    } finally {
      await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  },
);
