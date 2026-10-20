import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateFlagDraft } from "./generate";
import { createFlagPreviewHandler, FlagPreviewError } from "./service";
import { flagCreationPromptV1 } from "@/prompts/flag-creation.v1";

/** Interim Phase 5 adapter; replace with the shared Phase 4 runner when available. */
export const flagPreviewHandler = createFlagPreviewHandler({
  getUserId: async () => (await auth())?.user?.id ?? null,
  loadProject: async (projectId, userId) => {
    const project = await prisma.project.findFirst({
      where: { id: projectId, workspace: { members: { some: { userId } } } },
      select: {
        workspaceId: true,
        workspace: { select: { members: { where: { userId }, select: { role: true } } } },
        environments: { select: { key: true, name: true }, orderBy: { key: "asc" }, take: 21 },
        // Include archived keys too: the unique constraint reserves them permanently.
        flags: {
          take: 5001,
          orderBy: { key: "asc" },
          select: {
            key: true,
            environments: {
              where: { environment: { projectId } },
              select: { rules: true },
              take: 21,
            },
          },
        },
      },
    });
    const member = project?.workspace.members[0];
    if (!project || !member) return null;
    return {
      workspaceId: project.workspaceId,
      role: member.role,
      flags: project.flags,
      environments: project.environments,
    };
  },
  reserveRun: async ({ request, userId, workspaceId }) => {
    const cap = Number(process.env.AI_WORKSPACE_DAILY_BUDGET ?? "100");
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new FlagPreviewError(
        503,
        "AI_CONFIGURATION_ERROR",
        "The workspace AI budget is not configured correctly.",
      );
    }
    // Lock before counting and inserting a PENDING run: concurrent requests cannot overspend.
    // These locks coordinate this preview endpoint, not unmerged Phase 4 features.
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`flag-preview:user:${userId}`}))::text`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`flag-preview:workspace:${workspaceId}`}))::text`;
      const now = new Date();
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const recent = await tx.aiRun.count({
        where: {
          feature: "FLAG_CREATION",
          input: { path: ["userId"], equals: userId },
          createdAt: { gte: new Date(now.getTime() - 60_000) },
        },
      });
      if (recent >= 20)
        throw new FlagPreviewError(
          429,
          "RATE_LIMITED",
          "You have reached 20 flag previews per minute. Try again shortly.",
        );
      const daily = await tx.aiRun.count({ where: { workspaceId, createdAt: { gte: day } } });
      if (daily >= cap)
        throw new FlagPreviewError(
          429,
          "DAILY_BUDGET_EXCEEDED",
          "This workspace has reached its daily AI budget.",
        );
      const run = await tx.aiRun.create({
        data: {
          workspaceId,
          feature: "FLAG_CREATION",
          input: {
            userId,
            projectId: request.projectId,
            promptVersion: flagCreationPromptV1.version,
            requestLength: request.prompt.length,
            allowProduction: request.allowProduction,
          },
          model: "pending:flag-creation",
          latencyMs: 0,
          status: "PENDING",
        },
        select: { id: true },
      });
      return run.id;
    });
  },
  completeRun: async (id, result) => {
    await prisma.aiRun.update({
      where: { id },
      data: {
        status: "SUCCEEDED",
        output: result.draft,
        model: result.model,
        latencyMs: result.latencyMs,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      },
    });
  },
  failRun: async (id, code) => {
    await prisma.aiRun.update({ where: { id }, data: { status: "FAILED", error: code } });
  },
  generate: generateFlagDraft,
});
