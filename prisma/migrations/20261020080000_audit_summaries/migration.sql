-- Preserve every existing audit and its immediate, deterministic summary.
ALTER TABLE "AuditEvent"
  ADD COLUMN "summarySource" TEXT NOT NULL DEFAULT 'fallback',
  ADD COLUMN "summaryModel" TEXT,
  ADD COLUMN "summaryVersion" TEXT,
  ADD COLUMN "summarizedAt" TIMESTAMP(3);
