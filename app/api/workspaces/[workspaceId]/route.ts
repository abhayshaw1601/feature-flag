import { z } from "zod";
import { dataResponse, jsonError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceMember, requireWorkspaceRole } from "@/lib/workspace-auth";

const updateWorkspaceSchema = z.object({ name: z.string().trim().min(2).max(80) });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    await requireWorkspaceMember(workspaceId);
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      include: { projects: { include: { environments: true }, orderBy: { name: "asc" } } },
    });
    return dataResponse(workspace);
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    await requireWorkspaceRole(workspaceId, "ADMIN");
    const payload = updateWorkspaceSchema.parse(await request.json());
    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: { name: payload.name },
    });
    return dataResponse(workspace);
  } catch (error) {
    return jsonError(error);
  }
}
