import { z } from "zod";
import type { AuditFilters } from "./types";

const id = z.string().trim().min(1).max(128);
export const auditFiltersSchema = z
  .object({
    workspaceId: id,
    range: z.enum(["24h", "7d"]).default("24h"),
    projectId: id.optional(),
    flagId: id.optional(),
    actorId: id.optional(),
    environmentId: id.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  })
  .strict();
export type AuditQuery = z.infer<typeof auditFiltersSchema> & { from: string; to: string };

export function parseAuditFilters(input: unknown, now = new Date()): AuditQuery {
  if (input instanceof URLSearchParams) {
    const entries = [...input.entries()];
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new z.ZodError([
        { code: "custom", path: [], message: "Repeated query parameters are not allowed." },
      ]);
    }
    input = Object.fromEntries(entries);
  }
  const result = auditFiltersSchema.parse(input);
  const to = result.to ?? now.toISOString();
  const from =
    result.from ??
    new Date(new Date(to).getTime() - (result.range === "7d" ? 7 : 1) * 86400000).toISOString();
  if (new Date(from) > new Date(to)) {
    throw new z.ZodError([
      { code: "custom", path: ["from"], message: "The start date must not follow the end date." },
    ]);
  }
  return { ...result, from, to };
}

export function filterAuditRows<
  T extends {
    id: string;
    projectId: string;
    flagId: string | null;
    actor: { id: string } | null;
    environmentId: string | null;
    createdAt: string;
  },
>(rows: T[], filters: AuditFilters, now: Date): T[] {
  const query = parseAuditFilters({ workspaceId: "fixture", ...filters }, now);
  return rows
    .filter(
      (row) =>
        (!query.projectId || row.projectId === query.projectId) &&
        (!query.flagId || row.flagId === query.flagId) &&
        (!query.actorId || row.actor?.id === query.actorId) &&
        (!query.environmentId || row.environmentId === query.environmentId) &&
        new Date(row.createdAt) >= new Date(query.from) &&
        new Date(row.createdAt) <= new Date(query.to),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
