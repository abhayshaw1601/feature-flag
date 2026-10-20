import { flagSummarySchema, type FlagSummary } from "@flagforge/contracts";
import { demoFlags, demoProjects, demoEnvironments } from "@/lib/seed-data";
import { prisma } from "@/lib/prisma";

function serializedFlag(flag: {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  tags: string[];
  owner: { id: string; name: string | null } | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  environments: Array<{
    environmentId: string;
    environment: { key: string };
    enabled: boolean;
    rules: unknown;
    rolloutPercent: number;
    offValue: unknown;
    onValue: unknown;
    version: number;
    updatedAt: Date;
  }>;
}): FlagSummary {
  return flagSummarySchema.parse({
    id: flag.id,
    projectId: flag.projectId,
    key: flag.key,
    name: flag.name,
    description: flag.description,
    type: flag.type,
    tags: flag.tags,
    owner: flag.owner ? { id: flag.owner.id, name: flag.owner.name ?? "Unassigned" } : null,
    archivedAt: flag.archivedAt?.toISOString() ?? null,
    createdAt: flag.createdAt.toISOString(),
    updatedAt: flag.updatedAt.toISOString(),
    environments: flag.environments.map((environment) => ({
      environmentId: environment.environmentId,
      environmentKey: environment.environment.key,
      enabled: environment.enabled,
      rules: environment.rules,
      rolloutPercent: environment.rolloutPercent,
      offValue: environment.offValue,
      onValue: environment.onValue,
      version: environment.version,
      updatedAt: environment.updatedAt.toISOString(),
    })),
  });
}

export async function loadFlags(): Promise<{
  flags: FlagSummary[];
  source: "database" | "fixture";
}> {
  if (!process.env.DATABASE_URL) return { flags: demoFlags, source: "fixture" };

  try {
    const records = await prisma.flag.findMany({
      where: { projectId: demoProjects[0].id },
      orderBy: { updatedAt: "desc" },
      include: {
        owner: { select: { id: true, name: true } },
        environments: {
          include: { environment: { select: { key: true } } },
          orderBy: { environment: { key: "asc" } },
        },
      },
    });
    if (!records.length) return { flags: demoFlags, source: "fixture" };
    return { flags: records.map(serializedFlag), source: "database" };
  } catch (error) {
    console.warn("Database flags unavailable; using deterministic fixture data.", error);
    return { flags: demoFlags, source: "fixture" };
  }
}

export function environmentCountLabel(source: "database" | "fixture") {
  return source === "database"
    ? "from the seeded database"
    : `in the ${demoEnvironments.length}-environment fixture`;
}
