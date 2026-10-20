import { buildAuditDigest } from "./digest";
import { filterAuditRows, parseAuditFilters } from "./query";
import { normalizeAuditRow } from "./summaries";
import type { AuditFilters, AuditOptions, AuditOverview, AuditRow } from "./types";

export const demoAuditNow = "2026-10-20T12:00:00.000Z";
export const demoAuditOptions: AuditOptions = {
  projects: [
    { id: "demo_web", name: "Web storefront" },
    { id: "demo_api", name: "Commerce API" },
  ],
  flags: [
    { id: "demo_checkout", key: "checkout_v2", projectId: "demo_web" },
    { id: "demo_search", key: "new_search", projectId: "demo_web" },
    { id: "demo_payments", key: "payments_guard", projectId: "demo_api" },
  ],
  environments: [
    { id: "demo_web_prod", name: "Production", projectId: "demo_web" },
    { id: "demo_web_staging", name: "Staging", projectId: "demo_web" },
    { id: "demo_api_prod", name: "Production", projectId: "demo_api" },
  ],
  actors: [
    { id: "demo_priya", name: "Priya Shah" },
    { id: "demo_arjun", name: "Arjun Mehta" },
  ],
};

export const demoAuditRows: AuditRow[] = Array.from({ length: 60 }, (_, index) => {
  const flag = demoAuditOptions.flags[index % 3];
  const environment = demoAuditOptions.environments[index % 3];
  const actor = demoAuditOptions.actors[index % 2];
  const from = index % 3 === 0 ? 10 : 0;
  const to = index % 3 === 0 ? 50 : 10;
  return normalizeAuditRow({
    id: `demo_audit_${String(index + 1).padStart(3, "0")}`,
    projectId: flag.projectId,
    projectName: demoAuditOptions.projects.find((project) => project.id === flag.projectId)!.name,
    flagId: flag.id,
    flagKey: flag.key,
    environmentId: environment.id,
    environmentName: environment.name,
    environmentKey: environment.name.toLowerCase(),
    actor,
    actorName: null,
    action: "FLAG_UPDATED",
    before: { enabled: true, rolloutPercent: from },
    after: { enabled: true, rolloutPercent: to },
    createdAt: new Date(new Date(demoAuditNow).getTime() - (index * 2 + 1) * 3600000).toISOString(),
    summary: "",
    summarySource: "fallback",
    summaryModel: null,
    risky: false,
  });
});

export function filterDemoAudit(filters: AuditFilters = { range: "24h", page: 1 }): AuditOverview {
  const query = parseAuditFilters({ workspaceId: "demo", ...filters }, new Date(demoAuditNow));
  const rows = filterAuditRows(demoAuditRows, filters, new Date(demoAuditNow));
  return {
    items: rows.slice((query.page - 1) * 25, query.page * 25),
    pagination: { page: query.page, pageSize: 25, total: rows.length },
    digest: buildAuditDigest(rows, { from: query.from, to: query.to, totalCount: rows.length }),
  };
}
