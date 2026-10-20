import { Prisma, type PrismaClient } from "@prisma/client";
import { AiError } from "./errors";
import type { AiRunStore } from "./runner";

export const AI_USER_MINUTE_LIMIT = 20;

/** Durable limits across processes/serverless instances, with atomic admission + pending run. */
export function createPrismaAiRunStore(db: PrismaClient): AiRunStore {
  return {
    reserve(input) {
      return db.$transaction(
        async (tx) => {
          // Fixed lock order: global user first, workspace second. No API call while holding locks.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai:user:${input.userId}`}, 0))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai:workspace:${input.workspaceId}`}, 0))`;
          const member = await tx.member.findUnique({
            where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
            select: { id: true },
          });
          if (!member)
            throw new AiError("AI_FORBIDDEN", "You do not belong to this workspace.", 403);
          // Database time avoids application-instance clock skew at the limit boundaries.
          const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          const minuteStart = new Date(now.getTime() - 60000);
          const dayStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
          );
          const recent = await tx.aiRun.count({
            where: { userId: input.userId, createdAt: { gt: minuteStart } },
          });
          if (recent >= AI_USER_MINUTE_LIMIT) {
            throw new AiError(
              "AI_RATE_LIMIT",
              "You have reached 20 AI calls per minute. Try again shortly.",
              429,
              false,
              60,
            );
          }
          const daily = await tx.aiRun.count({
            where: { workspaceId: input.workspaceId, createdAt: { gte: dayStart } },
          });
          if (daily >= input.dailyLimit) {
            const retryAfter = Math.max(
              1,
              Math.ceil((dayStart.getTime() + 86400000 - now.getTime()) / 1000),
            );
            throw new AiError(
              "AI_DAILY_BUDGET",
              "This workspace has reached its daily AI call budget. It resets at midnight UTC.",
              429,
              false,
              retryAfter,
            );
          }
          const run = await tx.aiRun.create({
            data: {
              workspaceId: input.workspaceId,
              userId: input.userId,
              feature: input.feature,
              model: input.model,
              input: input.input as Prisma.InputJsonValue,
              status: "PENDING",
              latencyMs: 0,
              createdAt: now,
            },
            select: { id: true },
          });
          return run.id;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5000,
          timeout: 10000,
        },
      );
    },
    async finish(id, result) {
      await db.aiRun.update({
        where: { id },
        data: {
          status: result.status,
          output:
            result.output === undefined ? Prisma.DbNull : (result.output as Prisma.InputJsonValue),
          error: result.error ?? null,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
        },
      });
    },
  };
}
