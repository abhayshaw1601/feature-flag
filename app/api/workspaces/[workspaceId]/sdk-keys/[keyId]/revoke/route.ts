import { dataResponse, jsonError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceRole } from "@/lib/workspace-auth";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string; keyId: string }> },
) {
  try {
    const { workspaceId, keyId } = await params;
    const { session } = await requireWorkspaceRole(workspaceId, "ADMIN");
    const key = await prisma.sdkKey.findFirst({
      where: { id: keyId, environment: { project: { workspaceId } } },
      include: { environment: { include: { project: true } } },
    });
    if (!key)
      return dataResponse(
        { code: "KEY_NOT_FOUND", message: "SDK key not found." },
        { status: 404 },
      );
    if (key.revokedAt)
      return dataResponse({ id: key.id, revokedAt: key.revokedAt, alreadyRevoked: true });

    const revokedAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.sdkKey.updateMany({
        where: { id: key.id, revokedAt: null },
        data: { revokedAt },
      });
      if (result.count === 1) {
        await tx.auditEvent.create({
          data: {
            projectId: key.environment.projectId,
            environmentId: key.environmentId,
            actorId: session.user.id,
            action: "SDK_KEY_REVOKED",
            summary: `${key.name} SDK key revoked for ${key.environment.name}.`,
            before: { keyId: key.id, prefix: key.prefix },
            after: { revokedAt: revokedAt.toISOString() },
          },
        });
      }
      return result;
    });
    return dataResponse({ id: key.id, revokedAt, alreadyRevoked: updated.count === 0 });
  } catch (error) {
    return jsonError(error);
  }
}
