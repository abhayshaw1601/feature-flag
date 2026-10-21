import { z } from "zod";

export const memberRoleSchema = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const sdkKeyTypeSchema = z.enum(["SERVER", "CLIENT"]);
export type SdkKeyType = z.infer<typeof sdkKeyTypeSchema>;

export const flagTypeSchema = z.enum(["RELEASE", "OPS", "EXPERIMENT", "PERMISSION"]);
export type FlagType = z.infer<typeof flagTypeSchema>;

export const ruleOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "greater_than",
  "less_than",
]);
export type RuleOperator = z.infer<typeof ruleOperatorSchema>;

export const experimentStatusSchema = z.enum(["DRAFT", "RUNNING", "COMPLETED", "STOPPED"]);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

export const chatRoleSchema = z.enum(["USER", "ASSISTANT", "TOOL"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const aiFeatureSchema = z.enum([
  "FLAG_CREATION",
  "ROLLOUT_RISK",
  "STALE_CLEANUP",
  "AUDIT_SUMMARY",
  "AUTO_ROLLOUT",
  "IMPACT_ANALYSIS",
  "EXPERIMENT_ANALYSIS",
  "CHAT",
]);
export type AiFeature = z.infer<typeof aiFeatureSchema>;

export const jsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type JsonScalar = z.infer<typeof jsonScalarSchema>;

export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonScalarSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export const conditionSchema = z.object({
  attribute: z.string().trim().min(1).max(64),
  operator: ruleOperatorSchema,
  values: z.array(jsonScalarSchema).min(1).max(50),
});
export type Condition = z.infer<typeof conditionSchema>;

export const serveSchema = z.object({
  rolloutPercent: z.number().int().min(0).max(100),
});
export type Serve = z.infer<typeof serveSchema>;

export const ruleSchema = z.object({
  id: z.string().regex(/^rule_[a-z0-9_-]+$/),
  description: z.string().trim().min(1).max(240),
  conditions: z.array(conditionSchema).min(1).max(20),
  serve: serveSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

export const ruleSetSchema = z.object({
  rules: z.array(ruleSchema).max(50),
  defaultServe: serveSchema,
});
export type RuleSet = z.infer<typeof ruleSetSchema>;

export const flagEnvironmentConfigSchema = z.object({
  environmentId: z.string().min(1),
  environmentKey: z.string().regex(/^[a-z0-9-]+$/),
  enabled: z.boolean(),
  rules: ruleSetSchema,
  rolloutPercent: z.number().int().min(0).max(100),
  offValue: jsonValueSchema,
  onValue: jsonValueSchema,
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type FlagEnvironmentConfig = z.infer<typeof flagEnvironmentConfigSchema>;

export const flagSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  description: z.string().nullable(),
  type: flagTypeSchema,
  tags: z.array(z.string()),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  environments: z.array(flagEnvironmentConfigSchema),
});
export type FlagSummary = z.infer<typeof flagSummarySchema>;

export const flagDetailSchema = flagSummarySchema.extend({
  project: z.object({ id: z.string(), name: z.string(), key: z.string() }),
});
export type FlagDetail = z.infer<typeof flagDetailSchema>;

export const paginationSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const createApiSuccessSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({ data: dataSchema });
export type ApiSuccess<T> = { data: T };

export const listFlagsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  type: flagTypeSchema.optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  environment: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  sort: z.enum(["updatedAt", "name", "key"]).default("updatedAt"),
});
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;

export const listFlagsResponseSchema = z.object({
  items: z.array(flagSummarySchema),
  pagination: paginationSchema,
});
export type ListFlagsResponse = z.infer<typeof listFlagsResponseSchema>;

export const createFlagEnvironmentInputSchema = z.object({
  environmentKey: z.string().regex(/^[a-z0-9-]+$/),
  enabled: z.boolean(),
  rules: ruleSetSchema,
});
export type CreateFlagEnvironmentInput = z.infer<typeof createFlagEnvironmentInputSchema>;

export const createFlagRequestSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  name: z.string().trim().min(1).max(120),
  type: flagTypeSchema,
  description: z.string().trim().max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  ownerId: z.string().min(1).nullable().optional(),
  environments: z.array(createFlagEnvironmentInputSchema).max(20).optional(),
});
export type CreateFlagRequest = z.infer<typeof createFlagRequestSchema>;

export const updateFlagEnvironmentRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    rules: ruleSetSchema.optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    offValue: jsonValueSchema.optional(),
    onValue: jsonValueSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one environment value is required");
export type UpdateFlagEnvironmentRequest = z.infer<typeof updateFlagEnvironmentRequestSchema>;

export const auditEventSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  flagId: z.string().nullable(),
  environmentId: z.string().nullable(),
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  actorName: z.string().nullable(),
  action: z.string().min(1),
  summary: z.string().min(1),
  before: jsonValueSchema.nullable(),
  after: jsonValueSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  flagId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const evaluationUserSchema = z.object({
  id: z.string().min(1),
  attributes: z.record(z.string(), jsonScalarSchema),
});
export type EvaluationUser = z.infer<typeof evaluationUserSchema>;

export const serverFlagConfigSchema = z.object({
  key: z.string(),
  type: flagTypeSchema,
  enabled: z.boolean(),
  rules: ruleSetSchema,
  offValue: jsonValueSchema,
  onValue: jsonValueSchema,
  version: z.number().int().nonnegative(),
});
export type ServerFlagConfig = z.infer<typeof serverFlagConfigSchema>;

export const resolvedClientFlagSchema = z.object({
  key: z.string(),
  type: flagTypeSchema,
  value: jsonValueSchema,
  version: z.number().int().nonnegative(),
});
export type ResolvedClientFlag = z.infer<typeof resolvedClientFlagSchema>;

export const sdkConfigResponseSchema = z.object({
  environmentKey: z.string(),
  version: z.number().int().nonnegative(),
  flags: z.record(z.string(), z.union([serverFlagConfigSchema, resolvedClientFlagSchema])),
});
export type SdkConfigResponse = z.infer<typeof sdkConfigResponseSchema>;

export const exposureEventInputSchema = z.object({
  kind: z.literal("exposure"),
  flagKey: z.string().min(1),
  variation: z.string().min(1),
  userHash: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
});
export type ExposureEventInput = z.infer<typeof exposureEventInputSchema>;

export const metricEventInputSchema = z.object({
  kind: z.literal("metric"),
  flagKey: z.string().min(1),
  variation: z.string().min(1),
  metric: z.string().min(1).max(100),
  value: z.number().finite(),
  occurredAt: z.string().datetime().optional(),
});
export type MetricEventInput = z.infer<typeof metricEventInputSchema>;

export const sdkEventInputSchema = z.discriminatedUnion("kind", [
  exposureEventInputSchema,
  metricEventInputSchema,
]);
export type SdkEventInput = z.infer<typeof sdkEventInputSchema>;

export const ingestSdkEventsRequestSchema = z.object({
  events: z.array(sdkEventInputSchema).min(1).max(500),
});
export type IngestSdkEventsRequest = z.infer<typeof ingestSdkEventsRequestSchema>;

export const sdkStreamEventSchema = z.object({
  version: z.number().int().nonnegative(),
  changedFlagKeys: z.array(z.string().min(1)),
});
export type SdkStreamEvent = z.infer<typeof sdkStreamEventSchema>;

export const flagCreationOutputSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: flagTypeSchema,
  description: z.string(),
  environments: z.array(
    z.object({
      environmentKey: z.string(),
      enabled: z.boolean(),
      rules: ruleSetSchema,
    }),
  ),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type FlagCreationOutput = z.infer<typeof flagCreationOutputSchema>;

export const rolloutRiskOutputSchema = z.object({
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  reasons: z.array(z.string()),
  saferPlan: z.array(
    z.object({
      step: z.number().int().positive(),
      rolloutPercent: z.number().int().min(0).max(100),
      hold: z.string(),
      watch: z.string(),
    }),
  ),
  missingSafeguards: z.array(z.string()),
});
export type RolloutRiskOutput = z.infer<typeof rolloutRiskOutputSchema>;

export const staleCleanupOutputSchema = z.object({
  flagKey: z.string(),
  files: z.array(
    z.object({
      filePath: z.string(),
      originalContent: z.string(),
      editedContent: z.string(),
      explanation: z.string(),
    }),
  ),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
});
export type StaleCleanupOutput = z.infer<typeof staleCleanupOutputSchema>;

export const auditSummaryOutputSchema = z.object({
  eventId: z.string(),
  summary: z.string(),
});
export type AuditSummaryOutput = z.infer<typeof auditSummaryOutputSchema>;

export const auditDigestOutputSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  groups: z.array(
    z.object({
      projectId: z.string(),
      environmentId: z.string(),
      eventIds: z.array(z.string()),
      summary: z.string(),
    }),
  ),
  riskyEventIds: z.array(z.string()),
  markdown: z.string(),
});
export type AuditDigestOutput = z.infer<typeof auditDigestOutputSchema>;

export const autoRolloutOutputSchema = z.object({
  decision: z.enum(["ROLLBACK", "HOLD", "ADVANCE"]),
  explanation: z.string(),
  breachedMetrics: z.array(z.string()),
  incidentNote: z.string(),
});
export type AutoRolloutOutput = z.infer<typeof autoRolloutOutputSchema>;

export const impactAnalysisOutputSchema = z.object({
  affectedComponents: z.array(z.string()),
  onBehavior: z.string(),
  offBehavior: z.string(),
  userFacingPaths: z.array(z.string()),
  contractsTouched: z.array(z.string()),
  testCoverageNotes: z.array(z.string()),
  blastRadius: z.enum(["SMALL", "MEDIUM", "LARGE"]),
  references: z.array(
    z.object({
      referenceId: z.string(),
      explanation: z.string(),
    }),
  ),
});
export type ImpactAnalysisOutput = z.infer<typeof impactAnalysisOutputSchema>;

export const experimentAnalysisOutputSchema = z.object({
  summary: z.string(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  recommendation: z.enum(["SHIP", "KEEP_RUNNING", "STOP"]),
});
export type ExperimentAnalysisOutput = z.infer<typeof experimentAnalysisOutputSchema>;

export const chatOutputSchema = z.object({
  answer: z.string(),
  links: z.array(
    z.object({
      type: z.enum(["flag", "audit", "repository"]),
      id: z.string(),
      label: z.string(),
    }),
  ),
  toolCalls: z.array(
    z.object({
      tool: z.string(),
      input: jsonValueSchema,
      resultSummary: z.string().optional(),
    }),
  ),
});
export type ChatOutput = z.infer<typeof chatOutputSchema>;

export const aiOutputSchemas = {
  FLAG_CREATION: flagCreationOutputSchema,
  ROLLOUT_RISK: rolloutRiskOutputSchema,
  STALE_CLEANUP: staleCleanupOutputSchema,
  AUDIT_SUMMARY: auditSummaryOutputSchema,
  AUTO_ROLLOUT: autoRolloutOutputSchema,
  IMPACT_ANALYSIS: impactAnalysisOutputSchema,
  EXPERIMENT_ANALYSIS: experimentAnalysisOutputSchema,
  CHAT: chatOutputSchema,
} as const;

export type AiOutputByFeature = {
  [K in keyof typeof aiOutputSchemas]: z.infer<(typeof aiOutputSchemas)[K]>;
};
