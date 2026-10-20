import { flagTypeSchema } from "@flagforge/contracts";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

export const AI_TOOL_LIMITS = {
  defaultTake: 25,
  maxTake: 100,
  maxPage: 100,
  maxEnvironments: 100,
} as const;

const idSchema = z.string().trim().min(1).max(128);
const flagKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(80);
const pagingShape = {
  page: z.number().int().min(1).max(AI_TOOL_LIMITS.maxPage).default(1),
  take: z.number().int().min(1).max(AI_TOOL_LIMITS.maxTake).default(AI_TOOL_LIMITS.defaultTake),
};
const timeRangeShape = {
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};

function checkTimeRange(value: { from?: string; to?: string }, context: z.RefinementCtx) {
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "The end date must be on or after the start date.",
    });
  }
}

/** Only model-visible arguments belong here; identity comes exclusively from the server. */
export const aiToolRegistry = {
  list_flags: {
    name: "list_flags",
    description:
      "List a bounded page of flag metadata in the current workspace. Defaults to active flags; optionally filter by project, environment key, type, or search text.",
    parameters: z
      .object({
        projectId: idSchema.optional(),
        environment: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(80)
          .optional(),
        search: z.string().trim().min(1).max(100).optional(),
        type: flagTypeSchema.optional(),
        status: z.enum(["active", "archived", "all"]).default("active"),
        ...pagingShape,
      })
      .strict(),
  },
  get_flag: {
    name: "get_flag",
    description:
      "Get a flag by ID in the current workspace, including at most 100 environment configurations. A missing or inaccessible flag is not found.",
    parameters: z.object({ flagId: idSchema }).strict(),
  },
  get_audit_events: {
    name: "get_audit_events",
    description:
      "Read a bounded page of workspace audit summaries, newest first. Change payloads and actor account details are never returned. Optional from/to timestamps are inclusive UTC ISO dates.",
    parameters: z
      .object({
        projectId: idSchema.optional(),
        flagId: idSchema.optional(),
        environmentId: idSchema.optional(),
        ...timeRangeShape,
        ...pagingShape,
      })
      .strict()
      .superRefine(checkTimeRange),
  },
  get_metrics: {
    name: "get_metrics",
    description:
      "Read a bounded page of individual metric samples in the workspace, newest first, not aggregate statistics or total exposure counts. Optional from/to timestamps are inclusive UTC ISO dates.",
    parameters: z
      .object({
        projectId: idSchema.optional(),
        environmentId: idSchema.optional(),
        flagKey: flagKeySchema.optional(),
        metric: z.string().trim().min(1).max(100).optional(),
        ...timeRangeShape,
        ...pagingShape,
      })
      .strict()
      .superRefine(checkTimeRange),
  },
  get_references: {
    name: "get_references",
    description:
      "Find a bounded page of code references for a flag key in workspace repositories. Returns paths, lines, and source snippets, but no repository credentials.",
    parameters: z
      .object({
        flagKey: flagKeySchema,
        repositoryId: idSchema.optional(),
        ...pagingShape,
      })
      .strict(),
  },
} as const;

export const aiToolDefinitions = Object.values(aiToolRegistry);
export type AiToolName = keyof typeof aiToolRegistry;
export type AiToolArguments = {
  [Name in AiToolName]: z.input<(typeof aiToolRegistry)[Name]["parameters"]>;
};
type ParsedArguments<Name extends AiToolName> = z.output<
  (typeof aiToolRegistry)[Name]["parameters"]
>;

export type AiToolContext = Readonly<{ workspaceId: string; userId: string }>;

export class AiToolError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "UNKNOWN_TOOL" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "AiToolError";
  }
}

const flagSelect = {
  id: true,
  projectId: true,
  key: true,
  name: true,
  description: true,
  type: true,
  tags: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, name: true, key: true } },
} as const satisfies Prisma.FlagSelect;

function flagDetailSelect(workspaceId: string) {
  return {
    ...flagSelect,
    environments: {
      // A child relation must not expose another workspace even if its FK was misassigned.
      where: { environment: { project: { workspaceId } } },
      take: AI_TOOL_LIMITS.maxEnvironments,
      orderBy: { id: "asc" },
      select: {
        environmentId: true,
        environment: { select: { key: true, name: true } },
        enabled: true,
        rules: true,
        rolloutPercent: true,
        offValue: true,
        onValue: true,
        version: true,
        updatedAt: true,
      },
    },
  } as const satisfies Prisma.FlagSelect;
}

// In particular, never select before/after: SDK-key creation can persist secrets there.
const auditSelect = {
  id: true,
  projectId: true,
  flagId: true,
  environmentId: true,
  action: true,
  summary: true,
  createdAt: true,
} as const satisfies Prisma.AuditEventSelect;

const metricSelect = {
  id: true,
  environmentId: true,
  flagKey: true,
  variation: true,
  metric: true,
  value: true,
  createdAt: true,
} as const satisfies Prisma.MetricEventSelect;

const referenceSelect = {
  id: true,
  repositoryId: true,
  flagKey: true,
  filePath: true,
  line: true,
  snippet: true,
  lastSeenAt: true,
  repository: { select: { id: true, fullName: true } },
} as const satisfies Prisma.FlagReferenceSelect;

type FlagRow = Prisma.FlagGetPayload<{ select: typeof flagSelect }>;
type FlagDetailRow = Prisma.FlagGetPayload<{ select: ReturnType<typeof flagDetailSelect> }>;
type AuditRow = Prisma.AuditEventGetPayload<{ select: typeof auditSelect }>;
type MetricRow = Prisma.MetricEventGetPayload<{ select: typeof metricSelect }>;
type ReferenceRow = Prisma.FlagReferenceGetPayload<{ select: typeof referenceSelect }>;
type ReadQuery<Args, Select> = Omit<Args, "select" | "include" | "omit"> & { select: Select };

/** A Prisma client fits this read-only interface; tests can supply small structural fakes. */
export interface AiToolDatabase {
  member: {
    findUnique(args: {
      where: { workspaceId_userId: { workspaceId: string; userId: string } };
      select: { id: true };
    }): PromiseLike<{ id: string } | null>;
  };
  flag: {
    findMany(args: ReadQuery<Prisma.FlagFindManyArgs, typeof flagSelect>): PromiseLike<FlagRow[]>;
    findFirst(
      args: ReadQuery<Prisma.FlagFindFirstArgs, ReturnType<typeof flagDetailSelect>>,
    ): PromiseLike<FlagDetailRow | null>;
  };
  auditEvent: {
    findMany(
      args: ReadQuery<Prisma.AuditEventFindManyArgs, typeof auditSelect>,
    ): PromiseLike<AuditRow[]>;
  };
  metricEvent: {
    findMany(
      args: ReadQuery<Prisma.MetricEventFindManyArgs, typeof metricSelect>,
    ): PromiseLike<MetricRow[]>;
  };
  flagReference: {
    findMany(
      args: ReadQuery<Prisma.FlagReferenceFindManyArgs, typeof referenceSelect>,
    ): PromiseLike<ReferenceRow[]>;
  };
}

function flagMetadata(row: FlagRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    name: row.name,
    description: row.description,
    type: row.type,
    tags: row.tags,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    project: { id: row.project.id, name: row.project.name, key: row.project.key },
  };
}

function paging(args: { page: number; take: number }) {
  return { skip: (args.page - 1) * args.take, take: args.take };
}

function pageResult<Item>(items: Item[], args: { page: number; take: number }) {
  return { items, page: args.page, take: args.take };
}

function dateFilter(args: { from?: string; to?: string }): Prisma.DateTimeFilter | undefined {
  if (!args.from && !args.to) return undefined;
  return {
    ...(args.from ? { gte: new Date(args.from) } : {}),
    ...(args.to ? { lte: new Date(args.to) } : {}),
  };
}

const handlers = {
  async list_flags(db: AiToolDatabase, workspaceId: string, args: ParsedArguments<"list_flags">) {
    const rows = await db.flag.findMany({
      where: {
        project: { workspaceId },
        projectId: args.projectId,
        type: args.type,
        ...(args.status === "active" ? { archivedAt: null } : {}),
        ...(args.status === "archived" ? { archivedAt: { not: null } } : {}),
        ...(args.environment
          ? {
              environments: {
                some: { environment: { key: args.environment, project: { workspaceId } } },
              },
            }
          : {}),
        ...(args.search
          ? {
              OR: [
                { key: { contains: args.search, mode: "insensitive" } },
                { name: { contains: args.search, mode: "insensitive" } },
                { description: { contains: args.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: flagSelect,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      ...paging(args),
    });
    return pageResult(rows.map(flagMetadata), args);
  },

  async get_flag(db: AiToolDatabase, workspaceId: string, args: ParsedArguments<"get_flag">) {
    const row = await db.flag.findFirst({
      where: { id: args.flagId, project: { workspaceId } },
      select: flagDetailSelect(workspaceId),
    });
    if (!row) throw new AiToolError("NOT_FOUND", "Flag not found.");
    return {
      ...flagMetadata(row),
      environments: row.environments.map((config) => ({
        environmentId: config.environmentId,
        environmentKey: config.environment.key,
        environmentName: config.environment.name,
        enabled: config.enabled,
        rules: config.rules,
        rolloutPercent: config.rolloutPercent,
        offValue: config.offValue,
        onValue: config.onValue,
        version: config.version,
        updatedAt: config.updatedAt.toISOString(),
      })),
    };
  },

  async get_audit_events(
    db: AiToolDatabase,
    workspaceId: string,
    args: ParsedArguments<"get_audit_events">,
  ) {
    const rows = await db.auditEvent.findMany({
      where: {
        project: { workspaceId },
        projectId: args.projectId,
        flagId: args.flagId,
        environmentId: args.environmentId,
        createdAt: dateFilter(args),
      },
      select: auditSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...paging(args),
    });
    return pageResult(
      rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        flagId: row.flagId,
        environmentId: row.environmentId,
        action: row.action,
        summary: row.summary,
        createdAt: row.createdAt.toISOString(),
      })),
      args,
    );
  },

  async get_metrics(db: AiToolDatabase, workspaceId: string, args: ParsedArguments<"get_metrics">) {
    const rows = await db.metricEvent.findMany({
      where: {
        environment: { project: { workspaceId }, projectId: args.projectId },
        environmentId: args.environmentId,
        flagKey: args.flagKey,
        metric: args.metric,
        createdAt: dateFilter(args),
      },
      select: metricSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...paging(args),
    });
    return pageResult(
      rows.map((row) => ({
        id: row.id,
        environmentId: row.environmentId,
        flagKey: row.flagKey,
        variation: row.variation,
        metric: row.metric,
        value: row.value,
        createdAt: row.createdAt.toISOString(),
      })),
      args,
    );
  },

  async get_references(
    db: AiToolDatabase,
    workspaceId: string,
    args: ParsedArguments<"get_references">,
  ) {
    const rows = await db.flagReference.findMany({
      where: {
        repository: { workspaceId },
        repositoryId: args.repositoryId,
        flagKey: args.flagKey,
      },
      select: referenceSelect,
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
      ...paging(args),
    });
    return pageResult(
      rows.map((row) => ({
        id: row.id,
        repositoryId: row.repositoryId,
        flagKey: row.flagKey,
        filePath: row.filePath,
        line: row.line,
        snippet: row.snippet,
        lastSeenAt: row.lastSeenAt.toISOString(),
        repository: { id: row.repository.id, fullName: row.repository.fullName },
      })),
      args,
    );
  },
};

export type AiToolResults = {
  [Name in AiToolName]: Awaited<ReturnType<(typeof handlers)[Name]>>;
};

/**
 * Bind only an authenticated server identity. Never construct context from model arguments.
 * Membership is deliberately checked on EVERY call (including invalid calls), not cached.
 * Invalid arguments throw ZodError; access/lookup failures throw AiToolError.
 */
export function createAiToolDispatcher(context: AiToolContext, db: AiToolDatabase) {
  // Copy and validate identity so subsequent mutations of the caller's object cannot rebind it.
  const { workspaceId, userId } = z
    .object({ workspaceId: idSchema, userId: idSchema })
    .strict()
    .parse(context);

  async function dispatch<Name extends AiToolName>(
    name: Name,
    args: unknown,
  ): Promise<AiToolResults[Name]>;
  async function dispatch(name: string, args: unknown): Promise<AiToolResults[AiToolName]>;
  async function dispatch(name: string, args: unknown): Promise<AiToolResults[AiToolName]> {
    const member = await db.member.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { id: true },
    });
    if (!member) throw new AiToolError("FORBIDDEN", "You do not belong to this workspace.");

    switch (name) {
      case "list_flags":
        return handlers.list_flags(
          db,
          workspaceId,
          aiToolRegistry.list_flags.parameters.parse(args),
        );
      case "get_flag":
        return handlers.get_flag(db, workspaceId, aiToolRegistry.get_flag.parameters.parse(args));
      case "get_audit_events":
        return handlers.get_audit_events(
          db,
          workspaceId,
          aiToolRegistry.get_audit_events.parameters.parse(args),
        );
      case "get_metrics":
        return handlers.get_metrics(
          db,
          workspaceId,
          aiToolRegistry.get_metrics.parameters.parse(args),
        );
      case "get_references":
        return handlers.get_references(
          db,
          workspaceId,
          aiToolRegistry.get_references.parameters.parse(args),
        );
      default:
        throw new AiToolError("UNKNOWN_TOOL", "Unknown AI tool.");
    }
  }

  return dispatch;
}
