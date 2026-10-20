import { z } from "zod";
import { AiError } from "../ai/errors";
import { buildAuditDigest } from "./digest";
import { parseAuditFilters, type AuditQuery } from "./query";
import type { AuditOverview, AuditRow } from "./types";

export class AuditAccessError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type AuditSummaryResult = {
  output: { summaries: Array<{ eventId: string; summary: string }> };
  model: string;
  mock: boolean;
};
export type AuditDependencies = {
  getUserId(): Promise<string | null>;
  authorize(workspaceId: string, userId: string, write: boolean): Promise<void>;
  read(query: AuditQuery): Promise<{ items: AuditRow[]; digestRows: AuditRow[]; total: number }>;
  findEvents(workspaceId: string, ids: string[]): Promise<AuditRow[]>;
  generate(
    rows: AuditRow[],
    context: { workspaceId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<AuditSummaryResult>;
  persist(
    workspaceId: string,
    userId: string,
    rows: AuditRow[],
    result: AuditSummaryResult,
  ): Promise<number>;
  now?: () => Date;
};
export const summaryRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(128),
    eventIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, "Choose distinct events."),
  })
  .strict();

export function createAuditService(deps: AuditDependencies) {
  async function userId() {
    const id = await deps.getUserId();
    if (!id) throw new AuditAccessError(401, "UNAUTHENTICATED", "Sign in to view audit history.");
    return id;
  }
  return {
    async overview(input: unknown): Promise<AuditOverview> {
      const user = await userId();
      const query = parseAuditFilters(input, deps.now?.());
      await deps.authorize(query.workspaceId, user, false);
      const result = await deps.read(query);
      return {
        items: result.items,
        pagination: { page: query.page, pageSize: 25, total: result.total },
        digest: buildAuditDigest(result.digestRows, {
          from: query.from,
          to: query.to,
          totalCount: result.total,
        }),
      };
    },
    async summarize(input: unknown, signal?: AbortSignal) {
      const user = await userId();
      const { workspaceId, eventIds } = summaryRequestSchema.parse(input);
      await deps.authorize(workspaceId, user, true);
      const rows = await deps.findEvents(workspaceId, eventIds);
      if (rows.length !== eventIds.length || rows.some((row) => !eventIds.includes(row.id))) {
        throw new AuditAccessError(
          404,
          "NOT_FOUND",
          "One or more audit events were not found in this workspace.",
        );
      }
      const pending = rows.filter((row) => row.summarySource === "fallback");
      if (!pending.length)
        return {
          updated: 0,
          model: rows[0].summaryModel ?? "Stored summary",
          mock: rows.every((row) => row.summarySource === "mock"),
        };
      const generated = await deps.generate(pending, { workspaceId, userId: user }, signal);
      // Authorization is checked again before publication, including membership/role revocation.
      await deps.authorize(workspaceId, user, true);
      const updated = await deps.persist(workspaceId, user, pending, generated);
      return { updated, model: generated.model, mock: generated.mock };
    },
  };
}

export function auditErrorResponse(error: unknown): Response {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  if (error instanceof AiError && error.retryAfter)
    headers["Retry-After"] = String(error.retryAfter);
  if (error instanceof AuditAccessError || error instanceof AiError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers },
    );
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Check the filters or selected audit events and try again.",
        },
      },
      { status: 400, headers },
    );
  }
  return Response.json(
    {
      error: { code: "AUDIT_UNAVAILABLE", message: "Audit history is unavailable. Please retry." },
    },
    { status: 503, headers },
  );
}
