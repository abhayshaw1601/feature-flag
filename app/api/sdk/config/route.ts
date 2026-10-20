import { createHash } from "node:crypto";
import { sdkConfigResponseSchema } from "@flagforge/contracts";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function unauthorized() {
  return NextResponse.json(
    { error: { code: "INVALID_SDK_KEY", message: "A valid SDK key is required." } },
    { status: 401 },
  );
}

function hashKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return unauthorized();
  const rawKey = authorization.slice("Bearer ".length).trim();
  if (!rawKey) return unauthorized();

  const key = await prisma.sdkKey.findUnique({
    where: { hashedKey: hashKey(rawKey) },
    include: { environment: true },
  });
  if (!key || key.revokedAt) return unauthorized();

  const used = await prisma.sdkKey.updateMany({
    where: { id: key.id, revokedAt: null },
    data: { lastUsedAt: new Date() },
  });
  if (used.count !== 1) return unauthorized();

  if (key.type === "CLIENT") {
    return NextResponse.json({
      data: { environmentKey: key.environment.key, version: 1, flags: {} },
    });
  }

  const configs = await prisma.flagEnvironment.findMany({
    where: { environmentId: key.environmentId, flag: { archivedAt: null } },
    include: { flag: true },
    orderBy: { flag: { key: "asc" } },
  });
  const flags = Object.fromEntries(
    configs.map((config) => [
      config.flag.key,
      {
        key: config.flag.key,
        type: config.flag.type,
        enabled: config.enabled,
        rules: config.rules,
        offValue: config.offValue,
        onValue: config.onValue,
        version: config.version,
      },
    ]),
  );
  const data = sdkConfigResponseSchema.parse({
    environmentKey: key.environment.key,
    version: Math.max(1, ...configs.map((config) => config.version)),
    flags,
  });
  return NextResponse.json({ data });
}
