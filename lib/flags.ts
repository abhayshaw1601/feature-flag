import type { FlagDetail, FlagSummary, ListFlagsResponse } from "@flagforge/contracts";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createFlagService, type FlagHistory, type FlagProjectAccess } from "@/lib/flag-service";

export { FlagServiceError } from "@/lib/flag-errors";
export type { FlagHistory, FlagProjectAccess } from "@/lib/flag-service";

const service = createFlagService({
  getSession: auth,
  // Keep authorization, rows, and pagination counts in the same database snapshot.
  transaction: (work) => prisma.$transaction(work, { isolationLevel: "RepeatableRead" }),
});

/**
 * Server-only, authenticated project list. Returns { items, pagination }; never fixtures.
 * Query accepts the shared list schema (or URLSearchParams), rejecting unknown fields.
 * Sort: updatedAt descending, name/key ascending, with id as the stable tie-breaker.
 * environment selects flags having that project's environment config; all configs are returned.
 * Throws FlagServiceError for access/domain failures and ZodError for invalid input.
 * Database failures propagate to the caller.
 */
export function loadFlags(projectId: string, query?: unknown): Promise<ListFlagsResponse> {
  return service.loadFlags(projectId, query);
}

/** Authenticated, membership-scoped detail including project metadata and all environment configs. */
export function loadFlagDetail(id: string): Promise<FlagDetail> {
  return service.loadFlagDetail(id);
}

/** Authenticated flag history, newest first: page 1, pageSize 50, with a total count. */
export function loadFlagHistory(id: string): Promise<FlagHistory> {
  return service.loadFlagHistory(id);
}

/** Authenticated audit query; projectId or flagId is mandatory. Supports shared audit filters. */
export function loadAudit(query: unknown): Promise<FlagHistory> {
  return service.loadAudit(query);
}

/** EDITOR+ only. Validates input and owner, then atomically creates configs and a creation audit. */
export function createFlag(projectId: string, input: unknown): Promise<FlagSummary> {
  return service.createFlag(projectId, input);
}

/**
 * Authenticated shell context for a project: { project, workspace, role, actor }.
 * Missing and inaccessible projects both throw 404; no session throws 401.
 * This is a read access check, not a replacement for authorization on subsequent mutations.
 */
export function requireFlagProjectAccess(projectId: string): Promise<FlagProjectAccess> {
  return service.requireFlagProjectAccess(projectId);
}
