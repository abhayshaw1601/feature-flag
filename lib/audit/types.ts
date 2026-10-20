import { auditEventSchema, paginationSchema } from "@flagforge/contracts";
import { z } from "zod";

export const auditRowSchema = auditEventSchema.extend({
  projectName: z.string(),
  flagKey: z.string().nullable(),
  environmentName: z.string().nullable(),
  environmentKey: z.string().nullable(),
  summarySource: z.enum(["fallback", "ai", "mock"]),
  summaryModel: z.string().nullable(),
  risky: z.boolean(),
});
export type AuditRow = z.infer<typeof auditRowSchema>;

export const auditDigestSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  eventCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  groups: z.array(
    z.object({
      projectId: z.string(),
      projectName: z.string(),
      environmentId: z.string().nullable(),
      environmentName: z.string().nullable(),
      risky: z.boolean(),
      items: z.array(
        z.object({
          eventId: z.string(),
          summary: z.string(),
          createdAt: z.string().datetime(),
          flagKey: z.string().nullable(),
          risky: z.boolean(),
        }),
      ),
    }),
  ),
  markdown: z.string(),
});
export type AuditDigest = z.infer<typeof auditDigestSchema>;

export const auditOverviewSchema = z.object({
  items: z.array(auditRowSchema),
  pagination: paginationSchema,
  digest: auditDigestSchema,
});
export type AuditOverview = z.infer<typeof auditOverviewSchema>;

export type AuditOptions = {
  projects: Array<{ id: string; name: string }>;
  flags: Array<{ id: string; key: string; projectId: string }>;
  environments: Array<{ id: string; name: string; projectId: string }>;
  actors: Array<{ id: string; name: string }>;
};

export type AuditFilters = {
  range: "24h" | "7d";
  projectId?: string;
  flagId?: string;
  actorId?: string;
  environmentId?: string;
  from?: string;
  to?: string;
  page: number;
};
