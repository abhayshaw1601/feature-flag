"use client";

import { useEffect } from "react";
import { Check, X } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { auditOverviewSchema, type AuditFilters, type AuditRow } from "@/lib/audit/types";

export const AUDIT_PAGE_SIZE = 25;
export const AUDIT_BATCH_SIZE = 20;

export const auditOverviewResponseSchema = z.object({
  data: auditOverviewSchema.refine(
    (data) => data.pagination.pageSize === AUDIT_PAGE_SIZE && data.items.length <= AUDIT_PAGE_SIZE,
    "Expected a page of at most 25 audit events.",
  ),
});

export const auditSummaryResponseSchema = z.object({
  data: z.object({
    updated: z.number().int().min(0).max(AUDIT_BATCH_SIZE),
    model: z.string().trim().min(1),
    mock: z.boolean(),
  }),
});

export function updateAuditFilters(
  current: AuditFilters,
  patch: Partial<Omit<AuditFilters, "page">>,
): AuditFilters {
  const next = { ...current, ...patch, page: 1 };
  if ("projectId" in patch && patch.projectId !== current.projectId) {
    next.flagId = undefined;
    next.environmentId = undefined;
  }
  if ("range" in patch) {
    next.from = undefined;
    next.to = undefined;
  }
  return next;
}

export function auditOverviewUrl(workspaceId: string, filters: AuditFilters) {
  const query = new URLSearchParams({
    workspaceId,
    range: filters.range,
    page: String(filters.page),
    pageSize: String(AUDIT_PAGE_SIZE),
  });
  for (const key of ["projectId", "flagId", "actorId", "environmentId", "from", "to"] as const) {
    if (filters[key]) query.set(key, filters[key]);
  }
  return `/api/audit/overview?${query}`;
}

export function auditSummaryEventIds(items: AuditRow[]) {
  return items
    .filter((item) => item.summarySource === "fallback")
    .slice(0, AUDIT_BATCH_SIZE)
    .map((item) => item.id);
}

// datetime-local intentionally represents UTC here, regardless of the browser's time zone.
export function auditUtcInput(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, value.length) !== value
  ) {
    throw new Error("Enter a valid UTC date and time.");
  }
  return date.toISOString();
}

export function auditFilterError(filters: AuditFilters) {
  return filters.from && filters.to && Date.parse(filters.from) >= Date.parse(filters.to)
    ? "From (UTC) must be earlier than To (UTC)."
    : null;
}

export function formatAuditTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// Display-only backstop. Raw JSON and exported Markdown retain the original evidence.
export function auditText(value: string) {
  return value
    .replace(/[0-9#*]\uFE0F?\u20E3/g, "")
    .replace(
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu,
      "",
    )
    .trim();
}

export function AuditRisk({ risky }: { risky: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-foreground">
      <span className={`status-dot ${risky ? "text-warning" : "text-muted"}`} aria-hidden="true" />
      {risky ? "Risky change" : "No risk signal"}
    </span>
  );
}

export function AuditToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 4_000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] items-start gap-3 rounded-card border border-border bg-background p-4 text-sm sm:max-w-md"
    >
      <Check size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words">{message}</p>
      <Button variant="ghost" size="icon" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
