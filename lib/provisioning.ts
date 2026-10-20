import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type GithubProfileInput = {
  id?: string | number | null;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
};

function normalizeUsername(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export async function ensureUserWorkspace(
  userId: string,
  profile: GithubProfileInput,
  accountId?: string,
) {
  const username = profile.login ? normalizeUsername(profile.login) : undefined;
  const name = profile.name?.trim() || profile.login?.trim() || "GitHub user";
  const githubId = accountId ?? (profile.id !== undefined ? String(profile.id) : undefined);

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: userId } });
      if (!existing) throw new Error("Authenticated user was not found.");

      await tx.user.update({
        where: { id: userId },
        data: {
          ...(githubId ? { githubId } : {}),
          ...(username ? { githubUsername: username } : {}),
          name,
          email: profile.email ?? existing.email,
          image: profile.avatar_url ?? existing.image,
        },
      });

      const claim = await tx.user.updateMany({
        where: { id: userId, workspaceProvisionedAt: null },
        data: { workspaceProvisionedAt: new Date() },
      });

      let workspace = await tx.workspace.findFirst({
        where: { members: { some: { userId, role: "OWNER" } } },
        include: { projects: { include: { environments: true } } },
      });

      if (claim.count === 1 && !workspace) {
        workspace = await tx.workspace.create({
          data: {
            name: `${name}'s workspace`,
            slug: `${slugify(name)}-${userId.slice(-6).toLowerCase()}`,
            members: { create: { userId, role: "OWNER" } },
            projects: {
              create: {
                name: "Default project",
                key: "default",
                environments: {
                  create: [
                    { name: "Development", key: "development" },
                    { name: "Staging", key: "staging" },
                    { name: "Production", key: "production" },
                  ],
                },
              },
            },
          },
          include: { projects: { include: { environments: true } } },
        });
      }

      if (username) {
        const invitations = await tx.workspaceInvitation.findMany({
          where: { githubUsername: username, acceptedAt: null, revokedAt: null },
        });
        for (const invitation of invitations) {
          await tx.member.upsert({
            where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
            create: { workspaceId: invitation.workspaceId, userId, role: invitation.role },
            update: {},
          });
          await tx.workspaceInvitation.update({
            where: { id: invitation.id },
            data: { acceptedAt: new Date() },
          });
        }
      }

      return workspace;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
