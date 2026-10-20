import { Prisma, type PrismaClient } from "@prisma/client";
import { jsonValueSchema } from "@flagforge/contracts";
import { redactAiLog } from "../ai/sanitize";
import { auditSummaryV1 } from "../../prompts/audit-summary.v1";
import { normalizeAuditRow, summaryCandidates } from "./summaries";
import { auditRowSchema, type AuditOptions, type AuditRow } from "./types";
import { AuditAccessError, type AuditDependencies } from "./service";
import type { AuditQuery } from "./query";

const relations = {
  project: { select: { name: true } },
  flag: { select: { key: true, projectId: true } },
  environment: { select: { name: true, key: true, projectId: true } },
  actor: { select: { id: true, name: true } },
} satisfies Prisma.AuditEventInclude;
type StoredAudit = Prisma.AuditEventGetPayload<{ include: typeof relations }>;

/** Redact credentials without trimming or changing ordinary before/after targeting values. */
export function redactAuditSnapshot(value: unknown): unknown {
  if (typeof value === "string") {
    return /\b(?:Bearer\s|AIza[\w-]{20,}|gh[pousr]_|github_pat_|ff_(?:server|client)_)/i.test(value)
      ? redactAiLog(value)
      : value;
  }
  if (Array.isArray(value)) return value.map(redactAuditSnapshot);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /secret|token|password|authorization|cookie|api.?key|sdk.?key|private.?key|raw.?key|hashed.?key/i.test(
          key,
        )
          ? "[REDACTED]"
          : redactAuditSnapshot(child),
      ]),
    );
  return value;
}

function serialized(event: StoredAudit): AuditRow {
  const source =
    event.summaryVersion === auditSummaryV1.version &&
    (event.summarySource === "ai" || event.summarySource === "mock")
      ? event.summarySource
      : "fallback";
  return normalizeAuditRow(
    auditRowSchema.parse({
      id: event.id,
      projectId: event.projectId,
      projectName: event.project.name,
      flagId: event.flagId,
      // Never use a name from a malformed cross-project relation.
      flagKey: event.flag?.projectId === event.projectId ? event.flag.key : null,
      environmentId: event.environmentId,
      environmentName:
        event.environment?.projectId === event.projectId ? event.environment.name : null,
      environmentKey:
        event.environment?.projectId === event.projectId ? event.environment.key : null,
      actor: event.actor ? { id: event.actor.id, name: event.actor.name ?? "Unknown actor" } : null,
      actorName: event.actorName,
      action: event.action,
      before: jsonValueSchema.parse(redactAuditSnapshot(event.before)),
      after: jsonValueSchema.parse(redactAuditSnapshot(event.after)),
      summary: event.summary,
      summarySource: source,
      summaryModel: source === "fallback" ? null : event.summaryModel,
      createdAt: event.createdAt.toISOString(),
      risky: false,
    }),
  );
}

export function auditWhere(query: AuditQuery): Prisma.AuditEventWhereInput {
  return {
    project: { workspaceId: query.workspaceId },
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.flagId ? { flagId: query.flagId } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.environmentId ? { environmentId: query.environmentId } : {}),
    createdAt: { gte: new Date(query.from), lte: new Date(query.to) },
  };
}

export async function assertAuditMembership(
  db: Pick<Prisma.TransactionClient, "member">,
  workspaceId: string,
  userId: string,
  write: boolean,
) {
  const membership = await db.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership)
    throw new AuditAccessError(403, "FORBIDDEN", "You do not belong to this workspace.");
  if (write && membership.role === "VIEWER")
    throw new AuditAccessError(403, "FORBIDDEN", "Generating summaries requires editor access.");
}

export function createAuditRepository(db: PrismaClient) {
  const repository: Pick<AuditDependencies, "authorize" | "read" | "findEvents" | "persist"> = {
    authorize: (workspaceId, userId, write) =>
      assertAuditMembership(db, workspaceId, userId, write),
    read: (query) =>
      db.$transaction(
        async (tx) => {
          const where = auditWhere(query);
          const orderBy: Prisma.AuditEventOrderByWithRelationInput[] = [
            { createdAt: "desc" },
            { id: "asc" },
          ];
          const [items, digestRows, total] = await Promise.all([
            tx.auditEvent.findMany({
              where,
              include: relations,
              orderBy,
              skip: (query.page - 1) * 25,
              take: 25,
            }),
            tx.auditEvent.findMany({ where, include: relations, orderBy, take: 1000 }),
            tx.auditEvent.count({ where }),
          ]);
          return { items: items.map(serialized), digestRows: digestRows.map(serialized), total };
        },
        { isolationLevel: "RepeatableRead" },
      ),
    findEvents: async (workspaceId, ids) => {
      const events = await db.auditEvent.findMany({
        where: { id: { in: ids }, project: { workspaceId } },
        include: relations,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      });
      return events.map(serialized);
    },
    persist: (workspaceId, userId, rows, result) =>
      db.$transaction(async (tx) => {
        await assertAuditMembership(tx, workspaceId, userId, true);
        let updated = 0;
        for (const item of result.output.summaries) {
          const original = rows.find((row) => row.id === item.eventId);
          if (!original || !summaryCandidates(original).includes(item.summary))
            throw new AuditAccessError(
              502,
              "INVALID_SUMMARY",
              "A summary referenced unsupported facts.",
            );
          const saved = await tx.auditEvent.updateMany({
            where: { id: item.eventId, project: { workspaceId } },
            data: {
              summary: item.summary,
              summarySource: result.mock ? "mock" : "ai",
              summaryModel: result.model,
              summaryVersion: auditSummaryV1.version,
              summarizedAt: new Date(),
            },
          });
          updated += saved.count;
        }
        return updated;
      }),
  };
  return repository;
}

export async function loadAuditOptions(
  db: PrismaClient,
  workspaceId: string,
): Promise<AuditOptions> {
  // Call only after membership authorization; every catalog query is still workspace-scoped.
  const [projects, flags, environments, actors] = await Promise.all([
    db.project.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 1000,
    }),
    db.flag.findMany({
      where: { project: { workspaceId } },
      select: { id: true, key: true, projectId: true },
      orderBy: { key: "asc" },
      take: 1000,
    }),
    db.environment.findMany({
      where: { project: { workspaceId } },
      select: { id: true, name: true, projectId: true },
      orderBy: { name: "asc" },
      take: 1000,
    }),
    db.auditEvent.findMany({
      where: { project: { workspaceId }, actorId: { not: null } },
      select: { actor: { select: { id: true, name: true } } },
      distinct: ["actorId"],
      take: 1000,
    }),
  ]);
  return {
    projects,
    flags,
    environments,
    actors: actors.flatMap(({ actor }) =>
      actor ? [{ id: actor.id, name: actor.name ?? "Unknown actor" }] : [],
    ),
  };
}
