ALTER TABLE "AiRun" ADD COLUMN "userId" TEXT;

CREATE INDEX "AiRun_workspaceId_createdAt_idx" ON "AiRun"("workspaceId", "createdAt");
CREATE INDEX "AiRun_userId_createdAt_idx" ON "AiRun"("userId", "createdAt");
