import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { loadRiskContext } from "../lib/rollout-risk/context";
import { RolloutRiskError } from "../lib/rollout-risk/service";
import { snapshotAt } from "../lib/rollout-risk/types";

const request = {
  flagId: "flag-a",
  environmentId: "prod-a",
  expectedVersion: 3,
  after: snapshotAt(100),
};
const now = Date.parse("2026-10-20T10:00:00Z");
function fixture() {
  return {
    id: "flag-a",
    key: "checkout_v2",
    tags: ["payments"],
    projectId: "project-a",
    project: { workspaceId: "workspace-a", workspace: { members: [{ role: "EDITOR" }] } },
    environments: [
      { ...snapshotAt(5), version: 3, environment: { key: "production", projectId: "project-a" } },
    ],
  };
}

function database(flag: ReturnType<typeof fixture> | null) {
  let audits = 0;
  const db = {
    flag: {
      findFirst: async (args: Record<string, unknown>) => {
        assert.deepEqual(args.where, {
          id: "flag-a",
          archivedAt: null,
          project: { workspace: { members: { some: { userId: "editor-a" } } } },
        });
        const select = args.select as {
          environments: { where: unknown };
          project: { select: { workspace: { select: { members: { where: unknown } } } } };
        };
        assert.deepEqual(select.environments.where, { environmentId: "prod-a" });
        assert.deepEqual(select.project.select.workspace.select.members.where, {
          userId: "editor-a",
        });
        return flag;
      },
    },
    auditEvent: {
      findMany: async (args: Record<string, unknown>) => {
        audits++;
        assert.deepEqual(args.where, {
          projectId: "project-a",
          flagId: "flag-a",
          environmentId: "prod-a",
          createdAt: { gte: new Date(now - 15 * 60_000), lte: new Date(now) },
        });
        assert.equal(args.take, 20);
        return [{ actorId: "another-editor", createdAt: new Date(now - 1000) }];
      },
    },
  } as unknown as Pick<PrismaClient, "flag" | "auditEvent">;
  return { db, auditCalls: () => audits };
}

test("context derives tags, before state, environment, actor and recent edits from scoped data", async () => {
  const { db } = database(fixture());
  const context = await loadRiskContext(db, "editor-a", request, now);
  assert.equal(context.input.actorId, "editor-a");
  assert.equal(context.input.before.rolloutPercent, 5);
  assert.equal(context.input.after.rolloutPercent, 100);
  assert.deepEqual(context.input.tags, ["payments"]);
  assert.equal(context.input.recentChanges[0].actorId, "another-editor");
  assert.deepEqual(context.scope, {
    workspaceId: "workspace-a",
    actorId: "editor-a",
    changeId: "flag-a:prod-a:3",
  });
});

test("missing membership, viewer access, wrong environment project and stale versions fail closed", async () => {
  const cases: Array<{ record: ReturnType<typeof fixture> | null; status: number }> = [
    { record: null, status: 404 },
  ];
  const missingMember = fixture();
  missingMember.project.workspace.members = [];
  cases.push({ record: missingMember, status: 404 });
  const viewer = fixture();
  viewer.project.workspace.members[0].role = "VIEWER";
  cases.push({ record: viewer, status: 403 });
  const wrongProject = fixture();
  wrongProject.environments[0].environment.projectId = "outside";
  cases.push({ record: wrongProject, status: 404 });
  const noEnvironment = fixture();
  noEnvironment.environments = [];
  cases.push({ record: noEnvironment, status: 404 });
  const stale = fixture();
  stale.environments[0].version = 4;
  cases.push({ record: stale, status: 409 });
  for (const { record, status } of cases) {
    const fake = database(record);
    await assert.rejects(
      loadRiskContext(fake.db, "editor-a", request, now),
      (error: unknown) => error instanceof RolloutRiskError && error.status === status,
    );
    assert.equal(fake.auditCalls(), 0);
  }
});

test("inconsistent stored default percentages cannot produce a misleading assessment", async () => {
  const broken = fixture();
  broken.environments[0].rules.defaultServe.rolloutPercent = 100;
  await assert.rejects(
    loadRiskContext(database(broken).db, "editor-a", request, now),
    (error: unknown) =>
      error instanceof RolloutRiskError && error.code === "INVALID_STORED_TARGETING",
  );
});
