-- Phase 1: Auth.js identity fields and pending workspace invitations
ALTER TABLE "public"."User" RENAME COLUMN "avatarUrl" TO "image";
ALTER TABLE "public"."User" ALTER COLUMN "githubId" DROP NOT NULL;
ALTER TABLE "public"."User" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "public"."User" ADD COLUMN "githubUsername" TEXT;
ALTER TABLE "public"."User" ADD COLUMN "workspaceProvisionedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_githubUsername_key" ON "public"."User"("githubUsername");

CREATE TABLE "public"."WorkspaceInvitation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "githubUsername" TEXT NOT NULL,
  "role" "public"."MemberRole" NOT NULL DEFAULT 'VIEWER',
  "invitedById" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceInvitation_workspaceId_githubUsername_key" ON "public"."WorkspaceInvitation"("workspaceId", "githubUsername");
CREATE INDEX "WorkspaceInvitation_githubUsername_acceptedAt_revokedAt_idx" ON "public"."WorkspaceInvitation"("githubUsername", "acceptedAt", "revokedAt");
ALTER TABLE "public"."WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
