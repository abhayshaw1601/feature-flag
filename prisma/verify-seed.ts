import assert from "node:assert/strict";
import { prisma } from "../lib/prisma";

async function main() {
  const [workspaces, projects, environments, flags, auditEvents, metricEvents] = await Promise.all([
    prisma.workspace.count(),
    prisma.project.count(),
    prisma.environment.count(),
    prisma.flag.count(),
    prisma.auditEvent.count(),
    prisma.metricEvent.count(),
  ]);
  const metricDates = await prisma.metricEvent.findMany({ select: { createdAt: true } });
  const metricDays = new Set(
    metricDates.map(({ createdAt }) => createdAt.toISOString().slice(0, 10)),
  );
  assert.equal(workspaces, 1, "Expected one workspace");
  assert.equal(projects, 2, "Expected two projects");
  assert.equal(environments, 6, "Expected three environments per project");
  assert.equal(flags, 25, "Expected 25 flags");
  assert.equal(auditEvents, 200, "Expected 200 audit events");
  assert.ok(metricEvents > 0, "Expected metric events");
  assert.ok(metricDays.size >= 7, "Expected seven days of metric events");
  console.log(
    JSON.stringify({
      workspaces,
      projects,
      environments,
      flags,
      auditEvents,
      metricEvents,
      metricDays: metricDays.size,
    }),
  );
}

main()
  .catch((error) => {
    console.error("Seed verification failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
