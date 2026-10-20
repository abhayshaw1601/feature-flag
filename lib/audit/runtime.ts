import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAiConfig } from "../ai/config";
import { createPrismaAiRunStore } from "../ai/store";
import { generateAuditSummaries } from "./generate";
import { createAuditRepository } from "./repository";
import { createAuditService } from "./service";

const dependencies = {
  ...createAuditRepository(prisma),
  generate: (
    rows: Parameters<typeof generateAuditSummaries>[0],
    context: { workspaceId: string; userId: string },
    signal?: AbortSignal,
  ) =>
    generateAuditSummaries(rows, {
      context,
      signal,
      config: getAiConfig(),
      store: createPrismaAiRunStore(prisma),
    }),
};
export const auditService = createAuditService({
  ...dependencies,
  getUserId: async () => (await auth())?.user?.id ?? null,
});

/** Called after the response; the transactional fallback never depends on Gemini availability. */
export async function enrichCreatedFlagAudit(flagId: string, userId: string) {
  const events = await prisma.auditEvent.findMany({
    where: {
      flagId,
      action: "FLAG_CREATED",
      summarySource: "fallback",
      project: { workspace: { members: { some: { userId } } } },
    },
    select: { id: true, project: { select: { workspaceId: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (!events.length) return;
  const service = createAuditService({ ...dependencies, getUserId: async () => userId });
  await service.summarize({
    workspaceId: events[0].project.workspaceId,
    eventIds: events.map((event) => event.id),
  });
}
