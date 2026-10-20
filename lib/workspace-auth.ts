import type { MemberRole } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const roleRank: Record<MemberRole, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

export class AuthorizationError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

export async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) throw new AuthorizationError(401, "Sign in to continue.");
  return session;
}

export async function requireWorkspaceMember(workspaceId: string) {
  const session = await requireSession();
  const membership = await prisma.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
    include: { workspace: true, user: true },
  });
  if (!membership) throw new AuthorizationError(403, "You do not belong to this workspace.");
  return { session, membership };
}

export async function requireWorkspaceRole(workspaceId: string, minimumRole: MemberRole) {
  const result = await requireWorkspaceMember(workspaceId);
  if (roleRank[result.membership.role] < roleRank[minimumRole]) {
    throw new AuthorizationError(403, `This action requires ${minimumRole.toLowerCase()} access.`);
  }
  return result;
}

export function canInviteRole(actorRole: MemberRole, invitedRole: MemberRole) {
  if (invitedRole === "OWNER") return false;
  if (invitedRole === "ADMIN") return actorRole === "OWNER";
  return actorRole === "OWNER" || actorRole === "ADMIN";
}
