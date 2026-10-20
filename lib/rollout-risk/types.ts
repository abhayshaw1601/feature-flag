import { z } from "zod";
import { rolloutRiskOutputSchema, ruleSetSchema } from "@flagforge/contracts";

export const targetingSnapshotSchema = z
  .object({
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    rules: ruleSetSchema,
  })
  .strict()
  .refine((value) => value.rolloutPercent === value.rules.defaultServe.rolloutPercent, {
    message: "Rollout percentage must match the default serve percentage.",
    path: ["rolloutPercent"],
  });
export type TargetingSnapshot = z.infer<typeof targetingSnapshotSchema>;

export const rolloutRiskInputSchema = z.object({
  flagKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  environmentKey: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(80),
  actorId: z.string().min(1).max(200),
  before: targetingSnapshotSchema,
  after: targetingSnapshotSchema,
  recentChanges: z
    .array(z.object({ actorId: z.string().nullable(), createdAt: z.string().datetime() }))
    .max(20),
});
export type RolloutRiskInput = z.infer<typeof rolloutRiskInputSchema>;

export const rolloutRiskRequestSchema = z
  .object({
    flagId: z.string().min(1).max(200),
    environmentId: z.string().min(1).max(200),
    expectedVersion: z.number().int().nonnegative(),
    after: targetingSnapshotSchema,
  })
  .strict();

export const rolloutRiskAssessmentSchema = z.object({
  assessment: rolloutRiskOutputSchema,
  source: z.enum(["mock", "gemini", "fallback"]),
  model: z.string(),
  notice: z.string().nullable(),
  assessedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  cached: z.boolean(),
});
export type RolloutRiskAssessment = z.infer<typeof rolloutRiskAssessmentSchema>;

export function snapshotAt(rolloutPercent: number): TargetingSnapshot {
  return {
    enabled: true,
    rolloutPercent,
    rules: { rules: [], defaultServe: { rolloutPercent } },
  };
}
