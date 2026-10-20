import { normalizeAuditRow, sanitizeAuditLabel } from "./summaries";
import { auditDigestSchema, type AuditDigest, type AuditRow } from "./types";

export type AuditDigestOptions = { from: string; to: string; totalCount?: number };

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const groupKey = (row: { projectId: string; environmentId: string | null }) =>
  JSON.stringify([row.projectId, row.environmentId]);

/** Escape once as literal Markdown text, including HTML, autolinks, entities and line controls. */
function markdownText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[^\p{L}\p{N} ]/gu, (character) => `&#${character.codePointAt(0)};`);
}

/** Renders the same normalized source sentences as the JSON digest; never examines raw diffs. */
export function renderAuditMarkdown(digest: Omit<AuditDigest, "markdown">): string {
  const lines = [
    "# Audit digest",
    "",
    `Time range (inclusive): ${markdownText(digest.from)} to ${markdownText(digest.to)}`,
    `Events included: ${digest.eventCount} of ${digest.totalCount}`,
    "",
  ];
  if (digest.truncated)
    lines.push(
      "Truncated: this digest includes only the supplied events; additional matching events are not shown.",
      "",
    );
  if (!digest.groups.length) lines.push("No audit events in this time range.", "");
  for (const group of digest.groups) {
    lines.push(
      `## ${markdownText(sanitizeAuditLabel(group.projectName) ?? "Unknown project")} / ${markdownText(sanitizeAuditLabel(group.environmentName) ?? "Unspecified environment")}${group.risky ? " — Risk flagged" : ""}`,
      "",
    );
    for (const item of group.items)
      lines.push(
        `- ${item.risky ? "[Risk flagged] " : ""}${markdownText(item.summary)} (Event ID: ${markdownText(item.eventId)}; time: ${markdownText(item.createdAt)})`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

/** Scope/actor/flag filters belong to the authorized caller; date bounds are always enforced here. */
export function buildAuditDigest(rows: AuditRow[], options: AuditDigestOptions): AuditDigest {
  const from = auditDigestSchema.shape.from.parse(options.from);
  const to = auditDigestSchema.shape.to.parse(options.to);
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (start > end) throw new RangeError("Audit digest start must not be after its end.");
  if (
    options.totalCount !== undefined &&
    (!Number.isSafeInteger(options.totalCount) || options.totalCount < 0)
  )
    throw new RangeError("Audit digest totalCount must be a nonnegative integer.");

  const ordered = rows
    .filter((row) => {
      const time = Date.parse(row.createdAt);
      return time >= start && time <= end;
    })
    .map(normalizeAuditRow)
    .sort(
      (a, b) =>
        Number(b.risky) - Number(a.risky) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        compareText(a.id, b.id) ||
        compareText(groupKey(a), groupKey(b)) ||
        compareText(a.summary, b.summary) ||
        compareText(a.projectName, b.projectName) ||
        compareText(a.environmentName ?? "", b.environmentName ?? ""),
    );
  const seen = new Set<string>();
  const groups = new Map<string, AuditDigest["groups"][number]>();
  for (const row of ordered) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const key = groupKey(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        projectId: row.projectId,
        projectName: sanitizeAuditLabel(row.projectName) ?? "Unknown project",
        environmentId: row.environmentId,
        environmentName:
          sanitizeAuditLabel(row.environmentName) ?? sanitizeAuditLabel(row.environmentKey),
        risky: false,
        items: [],
      };
      groups.set(key, group);
    }
    group.risky ||= row.risky;
    group.items.push({
      eventId: row.id,
      summary: row.summary,
      createdAt: row.createdAt,
      flagKey: row.flagKey,
      risky: row.risky,
    });
  }
  const newest = (group: AuditDigest["groups"][number]) =>
    group.items.reduce((latest, item) => Math.max(latest, Date.parse(item.createdAt)), -Infinity);
  const totalCount = Math.max(options.totalCount ?? seen.size, seen.size);
  const digest: AuditDigest = {
    from,
    to,
    eventCount: seen.size,
    totalCount,
    truncated: totalCount > seen.size,
    groups: [...groups.values()].sort(
      (a, b) =>
        Number(b.risky) - Number(a.risky) ||
        newest(b) - newest(a) ||
        compareText(groupKey(a), groupKey(b)),
    ),
    markdown: "",
  };
  digest.markdown = renderAuditMarkdown(digest);
  return digest;
}
