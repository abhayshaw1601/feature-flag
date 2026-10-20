import {
  auditEventSchema,
  flagDetailSchema,
  flagSummarySchema,
  type AuditEvent,
  type FlagDetail,
  type FlagSummary,
  type ListFlagsResponse,
  type MemberRole,
  type Pagination,
} from "@flagforge/contracts";
import { Prisma } from "@prisma/client";
import { FlagServiceError } from "./flag-errors";
import {
  parseAuditQuery,
  parseCreateFlag,
  parseFlagScopeId,
  parseListFlagsQuery,
} from "./flag-query";

export type FlagHistory = { items: AuditEvent[]; pagination: Pagination };
export type FlagProjectAccess = {
  project: { id: string; workspaceId: string; name: string; key: string };
  workspace: { id: string; name: string; slug: string };
  role: MemberRole;
  actor: { id: string; name: string | null };
};

export type FlagTransaction = Pick<
  Prisma.TransactionClient,
  "project" | "member" | "environment" | "flag" | "auditEvent"
>;

/** Server dependencies. Production uses Auth.js and a repeatable-read Prisma transaction. */
export type FlagServiceDependencies = {
  getSession: () => Promise<{ user?: { id?: string } } | null>;
  transaction: <T>(work: (tx: FlagTransaction) => Promise<T>) => Promise<T>;
};

const flagRelations = (projectId: string) =>
  ({
    owner: { select: { id: true, name: true } },
    project: { select: { id: true, name: true, key: true } },
    environments: {
      // The two foreign keys alone do not enforce that a config's environment shares its project.
      where: { environment: { projectId } },
      include: { environment: { select: { key: true } } },
      orderBy: [{ environment: { key: "asc" } }, { id: "asc" }],
    },
  }) satisfies Prisma.FlagInclude;

type FlagRecord = Prisma.FlagGetPayload<{ include: ReturnType<typeof flagRelations> }>;
type AuditRecord = Prisma.AuditEventGetPayload<{
  include: { actor: { select: { id: true; name: true } } };
}>;

function serializeFlag(flag: FlagRecord): FlagDetail {
  const result = flagDetailSchema.safeParse({
    id: flag.id,
    projectId: flag.projectId,
    key: flag.key,
    name: flag.name,
    description: flag.description,
    type: flag.type,
    tags: flag.tags,
    owner: flag.owner ? { id: flag.owner.id, name: flag.owner.name ?? "Unnamed user" } : null,
    archivedAt: flag.archivedAt?.toISOString() ?? null,
    createdAt: flag.createdAt.toISOString(),
    updatedAt: flag.updatedAt.toISOString(),
    project: flag.project,
    environments: flag.environments.map((config) => ({
      environmentId: config.environmentId,
      environmentKey: config.environment.key,
      enabled: config.enabled,
      rules: config.rules,
      rolloutPercent: config.rolloutPercent,
      offValue: config.offValue,
      onValue: config.onValue,
      version: config.version,
      updatedAt: config.updatedAt.toISOString(),
    })),
  });
  if (!result.success) {
    // Invalid stored data is a server failure, not an input-validation (400) response.
    throw new Error("Stored flag data does not match the flag contract.", { cause: result.error });
  }
  return result.data;
}

function serializeAudit(event: AuditRecord): AuditEvent {
  const result = auditEventSchema.safeParse({
    id: event.id,
    projectId: event.projectId,
    flagId: event.flagId,
    environmentId: event.environmentId,
    actor: event.actor
      ? { id: event.actor.id, name: event.actor.name ?? event.actorName ?? "Unnamed user" }
      : null,
    actorName: event.actorName,
    action: event.action,
    summary: event.summary,
    before: event.before,
    after: event.after,
    createdAt: event.createdAt.toISOString(),
  });
  if (!result.success) {
    throw new Error("Stored audit data does not match the audit contract.", {
      cause: result.error,
    });
  }
  return result.data;
}

function notFound() {
  return new FlagServiceError(404, "NOT_FOUND", "The requested resource was not found.");
}

async function projectAccess(
  tx: FlagTransaction,
  projectId: string,
  userId: string,
): Promise<FlagProjectAccess> {
  const project = await tx.project.findFirst({
    where: { id: projectId, workspace: { members: { some: { userId } } } },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      key: true,
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          members: {
            where: { userId },
            select: { role: true, user: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  const membership = project?.workspace.members[0];
  if (!project || !membership) throw notFound();
  return {
    project: {
      id: project.id,
      workspaceId: project.workspaceId,
      name: project.name,
      key: project.key,
    },
    workspace: {
      id: project.workspace.id,
      name: project.workspace.name,
      slug: project.workspace.slug,
    },
    role: membership.role,
    actor: membership.user,
  };
}

async function flagAccess(tx: FlagTransaction, id: string, userId: string) {
  const flag = await tx.flag.findFirst({
    where: { id, project: { workspace: { members: { some: { userId } } } } },
    select: { projectId: true },
  });
  if (!flag) throw notFound();
  return projectAccess(tx, flag.projectId, userId);
}

function duplicateKey(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  return (
    (Array.isArray(target) &&
      target.length === 2 &&
      target.includes("projectId") &&
      target.includes("key")) ||
    target === "Flag_projectId_key_key"
  );
}

/**
 * The same authorized service is used by server pages, HTTP handlers, and offline behavior tests.
 * No caller-supplied actor/workspace IDs are trusted. Every operation authenticates independently.
 */
export function createFlagService(deps: FlagServiceDependencies) {
  async function userId() {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      throw new FlagServiceError(401, "AUTHORIZATION_REQUIRED", "Sign in to continue.");
    }
    return session.user.id;
  }

  async function requireFlagProjectAccess(projectId: string): Promise<FlagProjectAccess> {
    const actorId = await userId();
    const id = parseFlagScopeId(projectId);
    return deps.transaction((tx) => projectAccess(tx, id, actorId));
  }

  async function loadFlags(projectId: string, input?: unknown): Promise<ListFlagsResponse> {
    const actorId = await userId();
    const id = parseFlagScopeId(projectId);
    const query = parseListFlagsQuery(input);
    return deps.transaction(async (tx) => {
      await projectAccess(tx, id, actorId);
      const environment = query.environment
        ? await tx.environment.findUnique({
            where: { projectId_key: { projectId: id, key: query.environment } },
            select: { id: true },
          })
        : null;
      if (query.environment && !environment) {
        throw new FlagServiceError(
          400,
          "VALIDATION_ERROR",
          "Environment does not belong to this project.",
          {
            environment: ["Choose an environment in this project."],
          },
        );
      }
      const where: Prisma.FlagWhereInput = {
        projectId: id,
        ...(query.status === "active" ? { archivedAt: null } : {}),
        ...(query.status === "archived" ? { archivedAt: { not: null } } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(environment ? { environments: { some: { environmentId: environment.id } } } : {}),
        ...(query.search
          ? {
              OR: ["key", "name", "description"].map((field) => ({
                [field]: { contains: query.search, mode: "insensitive" },
              })),
            }
          : {}),
      };
      const items = await tx.flag.findMany({
        where,
        include: flagRelations(id),
        orderBy: [{ [query.sort]: query.sort === "updatedAt" ? "desc" : "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const total = await tx.flag.count({ where });
      return {
        items: items.map((flag) => flagSummarySchema.parse(serializeFlag(flag))),
        pagination: { page: query.page, pageSize: query.pageSize, total },
      };
    });
  }

  async function loadFlagDetail(flagId: string): Promise<FlagDetail> {
    const actorId = await userId();
    const id = parseFlagScopeId(flagId);
    return deps.transaction(async (tx) => {
      const { project } = await flagAccess(tx, id, actorId);
      const flag = await tx.flag.findFirst({
        where: { id, projectId: project.id },
        include: flagRelations(project.id),
      });
      if (!flag) throw notFound();
      return serializeFlag(flag);
    });
  }

  async function createFlag(projectId: string, input: unknown): Promise<FlagSummary> {
    const actorId = await userId();
    const id = parseFlagScopeId(projectId);
    const payload = parseCreateFlag(input);
    try {
      return await deps.transaction(async (tx) => {
        const access = await projectAccess(tx, id, actorId);
        if (access.role === "VIEWER") {
          throw new FlagServiceError(403, "FORBIDDEN", "This action requires editor access.");
        }
        if (payload.ownerId) {
          const owner = await tx.member.findUnique({
            where: {
              workspaceId_userId: { workspaceId: access.workspace.id, userId: payload.ownerId },
            },
            select: { userId: true },
          });
          if (!owner) {
            throw new FlagServiceError(
              400,
              "VALIDATION_ERROR",
              "Owner must belong to this workspace.",
              {
                ownerId: ["Choose a member of this workspace."],
              },
            );
          }
        }
        const environments = await tx.environment.findMany({
          where: { projectId: id },
          select: { id: true },
          orderBy: [{ key: "asc" }, { id: "asc" }],
        });
        const flag = await tx.flag.create({
          data: {
            projectId: id,
            key: payload.key,
            name: payload.name,
            description: payload.description ?? null,
            type: payload.type,
            tags: payload.tags,
            ownerId: payload.ownerId ?? null,
            environments: {
              create: environments.map((environment) => ({
                environmentId: environment.id,
                enabled: false,
                rules: { rules: [], defaultServe: { rolloutPercent: 0 } },
                rolloutPercent: 0,
                offValue: false,
                onValue: true,
                version: 1,
              })),
            },
          },
          include: flagRelations(id),
        });
        const snapshot = serializeFlag(flag);
        await tx.auditEvent.create({
          data: {
            projectId: id,
            flagId: flag.id,
            actorId: access.actor.id,
            actorName: access.actor.name,
            action: "FLAG_CREATED",
            summary: `Created flag ${flag.key}.`,
            before: Prisma.JsonNull,
            after: snapshot,
          },
        });
        return flagSummarySchema.parse(snapshot);
      });
    } catch (error) {
      // Catch outside the transaction so a uniqueness failure cannot commit partial writes.
      if (duplicateKey(error)) {
        throw new FlagServiceError(
          409,
          "DUPLICATE_FLAG_KEY",
          "A flag with this key already exists in this project.",
          {
            key: ["Choose a unique key for this project."],
          },
        );
      }
      throw error;
    }
  }

  async function loadAudit(input: unknown): Promise<FlagHistory> {
    const actorId = await userId();
    const query = parseAuditQuery(input);
    return deps.transaction(async (tx) => {
      const access = query.flagId
        ? await flagAccess(tx, query.flagId, actorId)
        : await projectAccess(tx, query.projectId!, actorId);
      if (query.projectId && query.projectId !== access.project.id) throw notFound();
      if (query.environmentId) {
        const environment = await tx.environment.findFirst({
          where: { id: query.environmentId, projectId: access.project.id },
          select: { id: true },
        });
        if (!environment) throw notFound();
      }
      const where: Prisma.AuditEventWhereInput = {
        projectId: access.project.id,
        ...(query.flagId ? { flagId: query.flagId } : {}),
        ...(query.environmentId ? { environmentId: query.environmentId } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };
      const events = await tx.auditEvent.findMany({
        where,
        include: { actor: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const total = await tx.auditEvent.count({ where });
      return {
        items: events.map(serializeAudit),
        pagination: { page: query.page, pageSize: query.pageSize, total },
      };
    });
  }

  function loadFlagHistory(id: string): Promise<FlagHistory> {
    return loadAudit({ flagId: id });
  }

  return {
    requireFlagProjectAccess,
    loadFlags,
    loadFlagDetail,
    createFlag,
    loadAudit,
    loadFlagHistory,
  };
}

export type FlagService = ReturnType<typeof createFlagService>;
