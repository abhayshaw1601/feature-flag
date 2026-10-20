import { randomBytes, createHash } from "node:crypto";
import { sdkKeyTypeSchema } from "@flagforge/contracts";
import { z } from "zod";
import { dataResponse, jsonError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceMember, requireWorkspaceRole } from "@/lib/workspace-auth";

const createKeySchema = z.object({
  environmentId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  type: sdkKeyTypeSchema,
});

function hashKey(rawKey: string) {
  return createHash("sha256").update(rawKey).digest("hex");
}

function prefixFor(rawKey: string) {
  return rawKey.slice(0, 18);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    await requireWorkspaceMember(workspaceId);
    const keys = await prisma.sdkKey.findMany({
      where: { environment: { project: { workspaceId } } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        type: true,
        prefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
        environment: {
          select: { id: true, name: true, key: true, project: { select: { name: true } } },
        },
      },
    });
    return dataResponse(keys);
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
    const { session } = await requireWorkspaceRole(workspaceId, "ADMIN");
    const payload = createKeySchema.parse(await request.json());
    const environment = await prisma.environment.findFirst({
      where: { id: payload.environmentId, project: { workspaceId } },
      include: { project: true },
    });
    if (!environment)
      return dataResponse(
        { code: "ENVIRONMENT_NOT_FOUND", message: "Environment not found." },
        { status: 404 },
      );

    const randomPart = randomBytes(32).toString("base64url");
    const rawKey = `ff_${payload.type.toLowerCase()}_${randomPart}`;
    const key = await prisma.$transaction(async (tx) => {
      const created = await tx.sdkKey.create({
        data: {
          environmentId: environment.id,
          name: payload.name,
          type: payload.type,
          hashedKey: hashKey(rawKey),
          prefix: prefixFor(rawKey),
        },
        select: { id: true, name: true, type: true, prefix: true, createdAt: true },
      });
      await tx.auditEvent.create({
        data: {
          projectId: environment.projectId,
          environmentId: environment.id,
          actorId: session.user.id,
          action: "SDK_KEY_CREATED",
          summary: `${payload.name} SDK key created for ${environment.name}.`,
          before: { keyId: created.id },
          after: { type: payload.type, prefix: created.prefix },
        },
      });
      return created;
    });

    return dataResponse(
      { ...key, environmentId: environment.id, environmentName: environment.name, secret: rawKey },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
