import { memberRoleSchema } from "@flagforge/contracts";
import { dataResponse, jsonError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { canInviteRole, requireWorkspaceMember, requireWorkspaceRole } from "@/lib/workspace-auth";
import { z } from "zod";

const invitationSchema = z.object({
  githubUsername: z
    .string()
    .trim()
    .regex(/^@?[a-zA-Z0-9-]+$/)
    .transform((value) => value.replace(/^@/, "").toLowerCase()),
  role: memberRoleSchema.default("VIEWER"),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    await requireWorkspaceMember(workspaceId);
    const invitations = await prisma.workspaceInvitation.findMany({
      where: { workspaceId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
      include: { invitedBy: { select: { name: true, githubUsername: true } } },
    });
    return dataResponse(invitations);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const { membership, session } = await requireWorkspaceRole(workspaceId, "EDITOR");
    const payload = invitationSchema.parse(await request.json());
    if (!canInviteRole(membership.role, payload.role)) {
      return dataResponse(
        { code: "ROLE_NOT_ALLOWED", message: "You cannot invite this role." },
        { status: 403 },
      );
    }

    const invitedUser = await prisma.user.findUnique({
      where: { githubUsername: payload.githubUsername },
    });
    if (invitedUser) {
      const member = await prisma.member.upsert({
        where: { workspaceId_userId: { workspaceId, userId: invitedUser.id } },
        create: { workspaceId, userId: invitedUser.id, role: payload.role },
        update: {},
        include: { user: { select: { id: true, name: true, githubUsername: true, image: true } } },
      });
      return dataResponse({ kind: "member", member }, { status: 201 });
    }

    const invitation = await prisma.workspaceInvitation.upsert({
      where: {
        workspaceId_githubUsername: { workspaceId, githubUsername: payload.githubUsername },
      },
      create: {
        workspaceId,
        githubUsername: payload.githubUsername,
        role: payload.role,
        invitedById: session.user.id,
      },
      update: {
        role: payload.role,
        invitedById: session.user.id,
        acceptedAt: null,
        revokedAt: null,
      },
    });
    return dataResponse({ kind: "invitation", invitation }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
