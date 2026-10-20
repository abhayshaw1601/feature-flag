import { auditSummaryOutputSchema } from "@flagforge/contracts";
import { z } from "zod";
import { auditSummaryV1 } from "../../prompts/audit-summary.v1";
import type { AiConfig } from "../ai/config";
import { AiError } from "../ai/errors";
import type { AiTransport } from "../ai/gemini";
import { runAi, type AiRunStore, type RunContext } from "../ai/runner";
import { redactAiLog, sanitizeAiText } from "../ai/sanitize";
import { summaryCandidates } from "./summaries";
import type { AuditRow } from "./types";

export type GenerateAuditSummariesOptions = {
  context: RunContext;
  config: AiConfig;
  store: AiRunStore;
  transport?: AiTransport;
  signal?: AbortSignal;
};

/** One authorized shared-runner batch. The caller owns authorization, caching and persistence. */
export async function generateAuditSummaries(
  rows: AuditRow[],
  options: GenerateAuditSummariesOptions,
) {
  if (
    rows.length < 1 ||
    rows.length > 20 ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some(
      ({ id }) =>
        !id ||
        id.length > 256 ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(id) ||
        sanitizeAiText(id) !== id ||
        redactAiLog(id) !== id,
    )
  )
    throw new AiError(
      "AI_INVALID_INPUT",
      "Provide 1 to 20 audit events with unique, safe event IDs.",
      400,
    );

  // Strict allowlist: no raw snapshots, cached prose, SDK metadata, rules, or targeting values.
  const events = rows.map((row) => ({ eventId: row.id, candidates: summaryCandidates(row) }));
  const candidatesById = new Map(events.map((event) => [event.eventId, event.candidates]));
  const eventIds = events.map((event) => event.eventId) as [string, ...string[]];
  const schema = auditSummaryV1.schema
    .extend({
      summaries: z
        .array(
          auditSummaryOutputSchema
            .extend({
              eventId: z.enum(eventIds),
              summary: z.string().min(1).max(2000),
            })
            .strict(),
        )
        .length(events.length),
    })
    .superRefine(({ summaries }, context) => {
      const seen = new Set<string>();
      summaries.forEach((item, index) => {
        if (seen.has(item.eventId))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["summaries", index, "eventId"],
            message: "Duplicate event ID.",
          });
        seen.add(item.eventId);
        if (!candidatesById.get(item.eventId)?.includes(item.summary))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["summaries", index, "summary"],
            message: "Choose an exact supplied candidate.",
          });
      });
    });

  return runAi({
    ...options,
    prompt: {
      ...auditSummaryV1,
      schema,
      fixture: {
        summaries: events.map(({ eventId, candidates }) => ({ eventId, summary: candidates[0] })),
      },
    },
    input: { events },
    logInput: {
      eventIds,
      count: events.length,
      projectIds: [...new Set(rows.map((row) => row.projectId))],
    },
  });
}
