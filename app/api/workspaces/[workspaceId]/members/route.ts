import { dataResponse, jsonError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceMember } from "@/lib/workspace-auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    await requireWorkspaceMember(workspaceId);
    const members = await prisma.member.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      include: {
        user: { select: { id: true, name: true, email: true, image: true, githubUsername: true } },
      },
    });
    return dataResponse(members);
  } catch (error) {
    return jsonError(error);
  }
}
