import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuditView, type AuditViewProps } from "../components/audit/audit-view";
import { AuditDigestCard } from "../components/audit/audit-digest-card";
import {
  auditFilterError,
  auditOverviewResponseSchema,
  auditOverviewUrl,
  auditSummaryEventIds,
  auditSummaryResponseSchema,
  auditUtcInput,
  formatAuditTime,
  updateAuditFilters,
} from "../components/audit/audit-ui";
import type {
  AuditDigest,
  AuditFilters,
  AuditOptions,
  AuditOverview,
  AuditRow,
} from "../lib/audit/types";

const options: AuditOptions = {
  projects: [
    { id: "project-store", name: "Storefront" },
    { id: "project-api", name: "API" },
  ],
  flags: [
    { id: "flag-checkout", key: "checkout_v2", projectId: "project-store" },
    { id: "flag-cache", key: "cache_v2", projectId: "project-api" },
  ],
  environments: [
    { id: "env-prod", name: "Production", projectId: "project-store" },
    { id: "env-staging", name: "Staging", projectId: "project-api" },
  ],
  actors: [{ id: "actor-priya", name: "Priya" }],
};

function row(index = 0, summarySource: AuditRow["summarySource"] = "fallback"): AuditRow {
  return {
    id: `event-${index}`,
    projectId: "project-store",
    projectName: "Storefront",
    flagId: "flag-checkout",
    flagKey: "checkout_v2",
    environmentId: "env-prod",
    environmentKey: "production",
    environmentName: "Production",
    actor: { id: "actor-priya", name: "Priya" },
    actorName: "Priya",
    action: "flag.environment.updated",
    summary: `Priya changed checkout_v2 in Production. Change ${index}.`,
    summarySource,
    summaryModel:
      summarySource === "fallback"
        ? null
        : summarySource === "ai"
          ? "gemini-2.5-flash"
          : "mock:audit-summary.v1",
    risky: index === 0,
    before: { rolloutPercent: 10 },
    after: { rolloutPercent: 50 },
    createdAt: "2026-10-20T10:30:00.000Z",
  };
}

function overview(items = [row(0), row(1, "ai"), row(2, "mock")]): AuditOverview {
  return {
    items,
    pagination: { page: 1, pageSize: 25, total: items.length },
    digest: {
      from: "2026-10-19T12:00:00.000Z",
      to: "2026-10-20T12:00:00.000Z",
      eventCount: items.length,
      totalCount: items.length,
      truncated: false,
      groups: items.length
        ? [
            {
              projectId: "project-store",
              projectName: "Storefront",
              environmentId: "env-prod",
              environmentName: "Production",
              risky: items.some((item) => item.risky),
              items: items.map((item) => ({
                eventId: item.id,
                summary: item.summary,
                flagKey: item.flagKey,
                risky: item.risky,
                createdAt: item.createdAt,
              })),
            },
          ]
        : [],
      markdown: `# What changed\n\n${items.map((item) => `- ${item.summary} (${item.id})`).join("\n")}\n`,
    },
  };
}

function renderView(props: Partial<AuditViewProps> = {}) {
  return renderToStaticMarkup(
    createElement(AuditView, {
      workspaceId: "workspace-test",
      initialData: overview(),
      options,
      canGenerate: true,
      ...props,
    }),
  );
}

function generationButton(html: string) {
  const button = html
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((value) => value.includes("Generate summaries"));
  assert.ok(button, "An explicit generation button is rendered");
  return button;
}

test("audit filters have associated labels, UTC inputs, presets, and 25-row pagination", () => {
  const html = renderView();
  for (const label of [
    "Project",
    "Flag",
    "Actor",
    "Environment",
    "Time range",
    "From (UTC)",
    "To (UTC)",
  ]) {
    const labels = [...html.matchAll(/<label for="([^"]+)"[^>]*>([^<]+)<\/label>/g)];
    const match = labels.find((entry) => entry[2] === label);
    assert.ok(match, `Label for ${label}`);
    assert.ok(html.includes(`id="${match[1]}"`), `Control for ${label}`);
  }
  for (const name of ["projectId", "flagId", "actorId", "environmentId", "range"]) {
    assert.match(html, new RegExp(`<select[^>]*name="${name}"`));
  }
  for (const name of ["from", "to"]) {
    const input = html.match(/<input\b[^>]*>/g)?.find((tag) => tag.includes(`name="${name}"`));
    assert.ok(input);
    assert.match(input, /type="datetime-local"/);
  }
  assert.match(html, /value="24h" selected=""/);
  assert.match(html, /value="7d"/);
  assert.match(html, /All times are UTC/);
  assert.match(html, /25 per page/);
  assert.match(html, /aria-label="Audit events pagination"/);
  assert.match(html, /focus-visible:ring-2/);
  assert.ok(html.indexOf("What changed") < html.indexOf("Event summaries"));
});

test("summary provenance, actor, flag, environment, risk text and UTC timestamps are honest", () => {
  const html = renderView();
  for (const text of [
    "Stored summary / fallback",
    "Gemini generated",
    "Mock",
    "gemini-2.5-flash",
    "mock:audit-summary.v1",
    "Actor: Priya",
    "checkout_v2",
    "Production",
    "Risky change",
    "No risk signal",
    "2026-10-20 10:30:00 UTC",
  ]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /status-dot text-warning/);
  assert.match(html, /Deterministic digest/);
  assert.match(html, /Fixture output, not live Gemini output/);
  assert.doesNotMatch(html, /Live AI digest/);
});

test("raw before and after JSON and summaries are escaped React text, with accessible expanders", () => {
  const item = row();
  item.before = { html: '<script>alert("before")</script>', enabled: false };
  item.after = { html: '<img src=x onerror="alert(1)">', enabled: true };
  item.summary = "<script>summary()</script> \u{1F680}";
  const html = renderView({ initialData: overview([item]) });
  assert.match(html, /<details/);
  assert.match(html, /View raw diff/);
  assert.match(html, /aria-label="Before JSON for event event-0"/);
  assert.match(html, /aria-label="After JSON for event event-0"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot;enabled&quot;: false/);
  assert.match(html, /&quot;enabled&quot;: true/);
  assert.doesNotMatch(html, /<script>|<img|\u{1F680}/u);
});

test("missing actor, flag and environment are represented without inventing identities", () => {
  const item = {
    ...row(),
    actor: null,
    actorName: null,
    flagId: null,
    flagKey: null,
    environmentId: null,
    environmentKey: null,
    environmentName: null,
    before: null,
  };
  const html = renderView({ initialData: overview([item]) });
  assert.match(html, /Actor: Unknown actor/);
  assert.match(html, /No flag/);
  assert.match(html, /Project-wide/);
  assert.match(html, />null<\/pre>/);
});

test("editor can generate eligible summaries; viewer, missing workspace, and demo gates disable it", () => {
  assert.doesNotMatch(generationButton(renderView()), / disabled=""/);
  const viewer = renderView({ canGenerate: false });
  assert.match(generationButton(viewer), / disabled=""/);
  assert.match(viewer, /Viewer access is read-only/);
  assert.match(generationButton(renderView({ workspaceId: "" })), / disabled=""/);
  const demo = renderView({ demo: true });
  assert.match(generationButton(demo), / disabled=""/);
  assert.match(demo, /Local fixture demo/);
  assert.match(demo, /Generation is disabled in this fixture demo/);
  assert.match(demo, /Filters read local fixtures only/);
});

test("only fallback events are eligible, capped at 20, with the next batch explained", () => {
  const items = Array.from({ length: 25 }, (_, index) => row(index));
  assert.deepEqual(
    auditSummaryEventIds(items),
    items.slice(0, 20).map((item) => item.id),
  );
  items[0] = row(0, "ai");
  items[1] = row(1, "mock");
  assert.deepEqual(
    auditSummaryEventIds(items),
    items.slice(2, 22).map((item) => item.id),
  );
  const html = renderView({ initialData: overview(items) });
  assert.match(html, /first 20 eligible rows/);
  assert.match(html, /remaining 3 on this page/);
  const completed = renderView({ initialData: overview([row(0, "ai"), row(1, "mock")]) });
  assert.match(generationButton(completed), / disabled=""/);
  assert.match(completed, /All visible events already have generated summaries/);
});

test("empty audit has explanatory text, a primary reset action, and disabled generation", () => {
  const html = renderView({ initialData: overview([]) });
  assert.match(html, /No audit events match these filters/);
  assert.match(html, /No changes in this scope/);
  assert.match(html, /<button[^>]*bg-foreground[^>]*>Reset filters<\/button>/);
  assert.match(generationButton(html), / disabled=""/);
  assert.match(html, /0 matching events/);
});

test("digest shows its exact UTC scope, provenance, and a warning for truncated source coverage", () => {
  const digest = { ...overview().digest, totalCount: 87, truncated: true };
  const html = renderToStaticMarkup(createElement(AuditDigestCard, { digest }));
  assert.match(html, /Digest truncated/);
  assert.match(html, /Includes 3 of 87 matching events/);
  assert.match(html, /2026-10-19 12:00:00 UTC/);
  assert.match(html, /2026-10-20 12:00:00 UTC/);
  assert.match(html, /across all pages/);
  assert.match(html, /Source event:/);
  assert.match(html, /event-0/);
  assert.match(html, /Export Markdown/);
  assert.match(html, /export includes only these supplied events/);
});

test("compact digest limits groups and entries in source order, linking to full audit", () => {
  const digest: AuditDigest = {
    ...overview().digest,
    eventCount: 12,
    totalCount: 12,
    groups: Array.from({ length: 3 }, (_, groupIndex) => ({
      projectId: `p-${groupIndex}`,
      projectName: `Project ${groupIndex}`,
      environmentId: null,
      environmentName: null,
      risky: groupIndex === 0,
      items: Array.from({ length: 4 }, (_, index) => ({
        eventId: `digest-${groupIndex}-${index}`,
        summary: `Digest entry ${groupIndex}-${index}`,
        createdAt: "2026-10-20T10:30:00.000Z",
        flagKey: null,
        risky: groupIndex === 0,
      })),
    })),
    markdown:
      "# Full provided digest\nIncludes all 12 source entries, including hidden compact entries.\n",
  };
  const html = renderToStaticMarkup(
    createElement(AuditDigestCard, { digest, compact: true, auditHref: "/demo/audit?range=7d" }),
  );
  assert.match(html, /Showing 6 of 12 included events/);
  assert.match(html, /Export contains the full provided digest/);
  assert.match(html, /href="\/demo\/audit\?range=7d"/);
  assert.match(html, /View full audit/);
  assert.match(html, /Digest entry 0-2/);
  assert.match(html, /Digest entry 1-2/);
  assert.doesNotMatch(html, /Digest entry 0-3|Project 2/);
  assert.ok(html.indexOf("Project 0") < html.indexOf("Project 1"));
  const full = renderToStaticMarkup(createElement(AuditDigestCard, { digest }));
  assert.match(full, /Digest entry 0-3/);
  assert.match(full, /Project 2/);
});

test("changing filters resets page and project changes clear dependent selections only", () => {
  const current: AuditFilters = {
    range: "24h",
    page: 4,
    projectId: "project-store",
    flagId: "flag-checkout",
    environmentId: "env-prod",
    actorId: "actor-priya",
  };
  const changed = updateAuditFilters(current, { projectId: "project-api" });
  assert.equal(changed.page, 1);
  assert.equal(changed.flagId, undefined);
  assert.equal(changed.environmentId, undefined);
  assert.equal(changed.actorId, "actor-priya");
  assert.equal(current.page, 4);
  for (const patch of [
    { flagId: "flag-other" },
    { actorId: undefined },
    { environmentId: undefined },
    { from: "2026-10-19T00:00:00.000Z" },
    { to: "2026-10-20T00:00:00.000Z" },
    { range: "7d" as const },
  ]) {
    assert.equal(updateAuditFilters(current, patch).page, 1);
  }
  const preset = updateAuditFilters(
    { ...current, from: "2026-10-19T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" },
    { range: "7d" },
  );
  assert.equal(preset.from, undefined);
  assert.equal(preset.to, undefined);
});

test("UTC input normalization and query encoding preserve scope without local timezone interpretation", () => {
  assert.equal(auditUtcInput("2026-10-20T14:05"), "2026-10-20T14:05:00.000Z");
  assert.equal(auditUtcInput(""), undefined);
  assert.throws(() => auditUtcInput("2026-02-30T14:05"));
  assert.throws(() => auditUtcInput("invalid"));
  assert.equal(formatAuditTime("2026-10-20T14:05:00.000Z"), "2026-10-20 14:05:00 UTC");
  const filters: AuditFilters = {
    range: "7d",
    page: 2,
    projectId: "project&range=24h",
    flagId: "flag",
    actorId: "actor",
    environmentId: "env",
    from: "2026-10-19T00:00:00.000Z",
    to: "2026-10-20T00:00:00.000Z",
  };
  const url = new URL(auditOverviewUrl("workspace&other", filters), "https://example.test");
  assert.equal(url.pathname, "/api/audit/overview");
  assert.equal(url.searchParams.get("workspaceId"), "workspace&other");
  assert.equal(url.searchParams.get("projectId"), "project&range=24h");
  assert.equal(url.searchParams.get("pageSize"), "25");
  for (const [key, value] of Object.entries(filters))
    assert.equal(url.searchParams.get(key), String(value));
  assert.equal(auditFilterError(filters), null);
  assert.match(auditFilterError({ ...filters, from: filters.to }) ?? "", /earlier than/);
});

test("overview and generation schemas reject invalid data before it is presented as success", () => {
  const data = overview();
  assert.equal(auditOverviewResponseSchema.safeParse({ data }).success, true);
  for (const invalid of [
    data,
    { data: { ...data, pagination: { page: 1, pageSize: 50, total: 3 } } },
    { data: { ...data, items: Array.from({ length: 26 }, (_, index) => row(index)) } },
    { data: { ...data, items: [{ ...row(), summarySource: "live" }] } },
    { data: { ...data, digest: { ...data.digest, markdown: null } } },
  ])
    assert.equal(auditOverviewResponseSchema.safeParse(invalid).success, false);
  assert.equal(
    auditSummaryResponseSchema.safeParse({
      data: { updated: 20, model: "gemini-2.5-flash", mock: false },
    }).success,
    true,
  );
  for (const invalid of [
    { updated: 21, model: "gemini", mock: false },
    { updated: -1, model: "gemini", mock: false },
    { updated: 1, model: "", mock: true },
    { updated: 1, model: "gemini" },
  ]) {
    assert.equal(auditSummaryResponseSchema.safeParse({ data: invalid }).success, false);
  }
});

test("server rendering initial live and demo data performs no network or generation requests", () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("Unexpected request during SSR");
  };
  try {
    renderView();
    renderView({ demo: true });
    renderToStaticMarkup(
      createElement(AuditDigestCard, { digest: overview().digest, compact: true }),
    );
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
