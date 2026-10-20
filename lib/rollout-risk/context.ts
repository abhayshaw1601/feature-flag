import type { PrismaClient } from "@prisma/client";
import type { z } from "zod";
import { RolloutRiskError } from "./service";
import { rolloutRiskInputSchema, type rolloutRiskRequestSchema } from "./types";

/** All risk facts except the proposed after state come from the authorized stored flag. */
export async function loadRiskContext(
  db: Pick<PrismaClient, "flag" | "auditEvent">,
  actorId: string,
  request: z.infer<typeof rolloutRiskRequestSchema>,
  now = Date.now(),
) {
  const flag = await db.flag.findFirst({
    where: {
      id: request.flagId,
      archivedAt: null,
      project: { workspace: { members: { some: { userId: actorId } } } },
    },
    select: {
      id: true,
      key: true,
      tags: true,
      projectId: true,
      project: {
        select: {
          workspaceId: true,
          workspace: {
            select: { members: { where: { userId: actorId }, select: { role: true } } },
          },
        },
      },
      environments: {
        where: { environmentId: request.environmentId },
        select: {
          enabled: true,
          rolloutPercent: true,
          rules: true,
          version: true,
          environment: { select: { key: true, projectId: true } },
        },
      },
    },
  });
  const member = flag?.project.workspace.members[0];
  if (!flag || !member)
    throw new RolloutRiskError(404, "NOT_FOUND", "The flag was not found in your workspace.");
  if (member.role === "VIEWER")
    throw new RolloutRiskError(
      403,
      "FORBIDDEN",
      "Assessing a proposed change requires editor access.",
    );
  const config = flag.environments[0];
  if (!config || config.environment.projectId !== flag.projectId)
    throw new RolloutRiskError(404, "NOT_FOUND", "The flag environment was not found.");
  if (config.version !== request.expectedVersion)
    throw new RolloutRiskError(
      409,
      "STALE_CHANGE",
      "The flag changed since you opened it. Reload and review the new configuration.",
    );
  const recent = await db.auditEvent.findMany({
    where: {
      projectId: flag.projectId,
      flagId: flag.id,
      environmentId: request.environmentId,
      createdAt: { gte: new Date(now - 15 * 60_000), lte: new Date(now) },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { actorId: true, createdAt: true },
  });
  const parsed = rolloutRiskInputSchema.safeParse({
    flagKey: flag.key,
    tags: flag.tags,
    environmentKey: config.environment.key,
    actorId,
    before: { enabled: config.enabled, rolloutPercent: config.rolloutPercent, rules: config.rules },
    after: request.after,
    recentChanges: recent.map((event) => ({
      actorId: event.actorId,
      createdAt: event.createdAt.toISOString(),
    })),
  });
  if (!parsed.success)
    throw new RolloutRiskError(
      409,
      "INVALID_STORED_TARGETING",
      "Stored targeting is inconsistent. Repair it before assessing this change.",
    );
  return {
    input: parsed.data,
    scope: {
      workspaceId: flag.project.workspaceId,
      actorId,
      changeId: `${flag.id}:${request.environmentId}:${config.version}`,
    },
  };
}
