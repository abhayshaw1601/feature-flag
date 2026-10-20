import { createHash } from "node:crypto";
import {
  AiRunStatus,
  AuditAction,
  ChatRole,
  ExperimentStatus,
  FlagType,
  MemberRole,
  PrismaClient,
  Prisma,
  SdkKeyType,
} from "@prisma/client";
import {
  demoEnvironments,
  demoProjects,
  demoWorkspace,
  demoOwners,
  seedDefinitions,
} from "../lib/seed-data";

const prisma = new PrismaClient();
const baseDate = new Date("2026-10-20T12:00:00.000Z");

function daysAgo(days: number, hour = 12) {
  const date = new Date(baseDate);
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

function keyHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function rolloutRules(rolloutPercent: number) {
  return {
    rules: [],
    defaultServe: { rolloutPercent },
  };
}

async function clearDatabase() {
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.aiRun.deleteMany();
  await prisma.flagReference.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.exposureEvent.deleteMany();
  await prisma.metricEvent.deleteMany();
  await prisma.sdkKey.deleteMany();
  await prisma.flagEnvironment.deleteMany();
  await prisma.experiment.deleteMany();
  await prisma.flag.deleteMany();
  await prisma.environment.deleteMany();
  await prisma.project.deleteMany();
  await prisma.member.deleteMany();
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
}

async function main() {
  await clearDatabase();

  const workspace = await prisma.workspace.create({ data: demoWorkspace });
  const users = await Promise.all([
    prisma.user.create({
      data: {
        id: demoOwners[0].id,
        githubId: "github_priya_shah",
        githubUsername: "priyashah",
        name: demoOwners[0].name,
        email: "priya@northstar.example",
        image: "https://avatars.githubusercontent.com/u/1",
      },
    }),
    prisma.user.create({
      data: {
        id: demoOwners[1].id,
        githubId: "github_mateo_ruiz",
        githubUsername: "mateoruiz",
        name: demoOwners[1].name,
        email: "mateo@northstar.example",
        image: "https://avatars.githubusercontent.com/u/2",
      },
    }),
    prisma.user.create({
      data: {
        id: demoOwners[2].id,
        githubId: "github_lin_chen",
        githubUsername: "linchen",
        name: demoOwners[2].name,
        email: "lin@northstar.example",
        image: "https://avatars.githubusercontent.com/u/3",
      },
    }),
    prisma.user.create({
      data: {
        id: demoOwners[3].id,
        githubId: "github_noor_patel",
        githubUsername: "noorpatel",
        name: demoOwners[3].name,
        email: "noor@northstar.example",
        image: "https://avatars.githubusercontent.com/u/4",
      },
    }),
  ]);
  const roles: MemberRole[] = ["OWNER", "ADMIN", "EDITOR", "VIEWER"];
  await prisma.member.createMany({
    data: users.map((user, index) => ({
      workspaceId: workspace.id,
      userId: user.id,
      role: roles[index],
    })),
  });

  const projects = await Promise.all(
    demoProjects.map((project) =>
      prisma.project.create({ data: { ...project, workspaceId: workspace.id } }),
    ),
  );
  const environments = await Promise.all(
    demoEnvironments.map((environment) =>
      prisma.environment.create({ data: { ...environment, projectId: projects[0].id } }),
    ),
  );
  await prisma.environment.createMany({
    data: [
      {
        id: "env_growth_development",
        projectId: projects[1].id,
        name: "Development",
        key: "development",
      },
      { id: "env_growth_staging", projectId: projects[1].id, name: "Staging", key: "staging" },
      {
        id: "env_growth_production",
        projectId: projects[1].id,
        name: "Production",
        key: "production",
      },
    ],
  });

  for (const environment of environments) {
    for (const type of ["SERVER", "CLIENT"] as SdkKeyType[]) {
      const rawKey = `ff_${environment.key}_${type.toLowerCase()}_demo_${environment.id}`;
      await prisma.sdkKey.create({
        data: {
          environmentId: environment.id,
          name: `${environment.name} ${type.toLowerCase()} key`,
          type,
          hashedKey: keyHash(rawKey),
          prefix: rawKey.slice(0, 18),
          createdAt: daysAgo(14),
          lastUsedAt: type === "SERVER" ? daysAgo(1, 10) : null,
        },
      });
    }
  }

  const flags: Array<{ id: string; key: string; name: string }> = [];
  for (let index = 0; index < seedDefinitions.length; index += 1) {
    const definition = seedDefinitions[index];
    const flag = await prisma.flag.create({
      data: {
        id: `flag_${String(index + 1).padStart(3, "0")}`,
        projectId: projects[0].id,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        type: definition.type as FlagType,
        tags: definition.tags,
        ownerId: definition.owner?.id ?? null,
        archivedAt: definition.archived ? daysAgo(2) : null,
        createdAt: daysAgo(definition.ageDays + 18),
        updatedAt: daysAgo(definition.ageDays),
        environments: {
          create: environments.map((environment, environmentIndex) => {
            const rolloutPercent = definition.rollout[environmentIndex];
            return {
              id: `flag_env_${String(index + 1).padStart(3, "0")}_${environment.key}`,
              environment: { connect: { id: environment.id } },
              enabled: rolloutPercent > 0,
              rules: definition.rules ?? rolloutRules(rolloutPercent),
              rolloutPercent,
              offValue: false,
              onValue: true,
              version: Math.max(1, 12 - definition.ageDays + environmentIndex),
              createdAt: daysAgo(definition.ageDays + 18),
              updatedAt: daysAgo(Math.max(0, definition.ageDays - environmentIndex)),
            };
          }),
        },
      },
    });
    flags.push(flag);
  }

  for (const definition of seedDefinitions.filter((item) => item.type === "EXPERIMENT")) {
    const flag = flags.find((item) => item.key === definition.key);
    if (!flag) continue;
    await prisma.experiment.create({
      data: {
        flagId: flag.id,
        name: `${definition.name} experiment`,
        primaryMetric: "checkout_conversion",
        guardrailMetrics: ["error_rate", "latency_p95"],
        minimumSampleSize: 1000,
        status: ExperimentStatus.RUNNING,
        startedAt: daysAgo(7),
      },
    });
  }

  const repository = await prisma.repository.create({
    data: {
      workspaceId: workspace.id,
      githubRepoId: "948201",
      fullName: "northstar-labs/checkout-service",
      installationId: "installation_demo_01",
      lastScannedAt: daysAgo(1, 9),
    },
  });
  const staleKeys = ["legacy_checkout", "checkout_observability", "returns_portal_v2"];
  await prisma.flagReference.createMany({
    data: staleKeys.flatMap((flagKey, flagIndex) =>
      Array.from({ length: flagIndex === 0 ? 5 : 2 }, (_, referenceIndex) => ({
        repositoryId: repository.id,
        flagKey,
        filePath: `src/${flagKey.replaceAll("_", "/")}/${referenceIndex + 1}.ts`,
        line: 42 + referenceIndex * 11,
        snippet: `isEnabled("${flagKey}", context)`,
        lastSeenAt: daysAgo(flagIndex + referenceIndex + 3),
      })),
    ),
  });

  const auditActions: AuditAction[] = [
    "FLAG_UPDATED",
    "ENVIRONMENT_UPDATED",
    "FLAG_CREATED",
    "EXPERIMENT_UPDATED",
    "AUTO_RAMP",
  ];
  await prisma.auditEvent.createMany({
    data: Array.from({ length: 200 }, (_, index) => {
      const flag = flags[index % flags.length];
      const environment = environments[index % environments.length];
      const actor = users[index % users.length];
      const action = auditActions[index % auditActions.length];
      const rolloutPercent = (index * 7) % 101;
      return {
        id: `audit_${String(index + 1).padStart(3, "0")}`,
        projectId: projects[0].id,
        flagId: flag.id,
        environmentId: environment.id,
        actorId: index % 17 === 0 ? null : actor.id,
        actorName: index % 17 === 0 ? "FlagForge Guard" : null,
        action,
        before: { rolloutPercent: Math.max(0, rolloutPercent - 5), enabled: rolloutPercent > 0 },
        after: { rolloutPercent, enabled: rolloutPercent > 0 },
        summary:
          index % 17 === 0
            ? `${flag.name} was checked by the rollout guard.`
            : `${actor.name} updated ${flag.name} in ${environment.name}.`,
        createdAt: new Date(baseDate.getTime() - index * 43 * 60 * 1000),
      };
    }),
  });

  const productionEnvironment = environments[2];
  const metricNames = ["checkout_conversion", "error_rate", "latency_p95"];
  const metricEvents = [];
  const exposureEvents = [];
  for (let day = 0; day < 7; day += 1) {
    for (let sample = 0; sample < 12; sample += 1) {
      const flag = flags[(day * 3 + sample) % flags.length];
      const variation = sample % 2 === 0 ? "on" : "off";
      const createdAt = daysAgo(day, 7 + sample);
      exposureEvents.push({
        environmentId: productionEnvironment.id,
        flagKey: flag.key,
        variation,
        userHash: keyHash(`demo-user-${day}-${sample}`),
        createdAt,
      });
      metricEvents.push({
        environmentId: productionEnvironment.id,
        flagKey: flag.key,
        variation,
        metric: metricNames[sample % metricNames.length],
        value: Number((variation === "on" ? 0.61 + day * 0.004 : 0.58 + day * 0.002).toFixed(4)),
        createdAt,
      });
    }
  }
  await prisma.exposureEvent.createMany({ data: exposureEvents });
  await prisma.metricEvent.createMany({ data: metricEvents });

  await prisma.aiRun.createMany({
    data: [
      {
        workspaceId: workspace.id,
        feature: "FLAG_CREATION",
        input: { prompt: "Gate the new checkout layout for pro customers." },
        output: { key: "checkout_refresh" },
        model: "gemini-2.5-pro",
        latencyMs: 842,
        tokensIn: 87,
        tokensOut: 164,
        status: AiRunStatus.SUCCEEDED,
        createdAt: daysAgo(2),
      },
      {
        workspaceId: workspace.id,
        feature: "ROLLOUT_RISK",
        input: { flagKey: "payment_retry_guard" },
        output: { riskLevel: "LOW" },
        model: "gemini-2.5-pro",
        latencyMs: 611,
        tokensIn: 122,
        tokensOut: 93,
        status: AiRunStatus.SUCCEEDED,
        createdAt: daysAgo(1),
      },
      {
        workspaceId: workspace.id,
        feature: "AUDIT_SUMMARY",
        input: { period: "7d" },
        output: Prisma.JsonNull,
        model: "gemini-2.5-flash",
        latencyMs: 350,
        tokensIn: 42,
        tokensOut: 0,
        status: AiRunStatus.FAILED,
        error: "Provider response timed out.",
        createdAt: daysAgo(1, 16),
      },
    ],
  });

  const thread = await prisma.chatThread.create({
    data: { workspaceId: workspace.id, userId: users[0].id },
  });
  await prisma.chatMessage.createMany({
    data: [
      {
        threadId: thread.id,
        role: ChatRole.USER,
        content: "Which Production flags are still below full rollout?",
        createdAt: daysAgo(0, 9),
      },
      {
        threadId: thread.id,
        role: ChatRole.TOOL,
        content: "Checked 25 flags in the Production environment.",
        toolCalls: [{ tool: "list_flags", input: { environment: "production" } }],
        createdAt: daysAgo(0, 9),
      },
      {
        threadId: thread.id,
        role: ChatRole.ASSISTANT,
        content:
          "There are 13 Production flags below full rollout. The largest remaining rollout is Address validation v2 at 50 percent.",
        createdAt: daysAgo(0, 9),
      },
    ],
  });

  const [
    workspaceCount,
    projectCount,
    environmentCount,
    flagCount,
    auditEventCount,
    metricEventCount,
  ] = await Promise.all([
    prisma.workspace.count(),
    prisma.project.count(),
    prisma.environment.count(),
    prisma.flag.count(),
    prisma.auditEvent.count(),
    prisma.metricEvent.count(),
  ]);
  if (
    workspaceCount !== 1 ||
    projectCount !== 2 ||
    environmentCount !== 6 ||
    flagCount !== 25 ||
    auditEventCount !== 200 ||
    metricEventCount < 7
  ) {
    throw new Error(
      `Seed verification failed: ${JSON.stringify({ workspaceCount, projectCount, environmentCount, flagCount, auditEventCount, metricEventCount })}`,
    );
  }
  console.log(
    "Seeded Northstar Labs with 2 projects, 3 environments per project, 25 flags, 200 audit events, and 7 days of events.",
  );
}

main()
  .catch((error) => {
    console.error("Seed failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
