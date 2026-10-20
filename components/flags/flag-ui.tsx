"use client";

import { useId, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy } from "lucide-react";
import type { FlagEnvironmentConfig, FlagType, Pagination } from "@flagforge/contracts";
import { Button } from "@/components/ui/button";

export const typeLabels: Record<FlagType, string> = {
  RELEASE: "Release",
  OPS: "Ops",
  EXPERIMENT: "Experiment",
  PERMISSION: "Permission",
};

export const fieldClassName =
  "w-full min-w-0 rounded-control border border-[var(--border-strong)] bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait aria-[invalid=true]:border-danger";

export const primaryActionClassName = "min-h-11 bg-accent text-background sm:min-h-9";

export function formatFlagDate(value: string, includeTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime
      ? ({ hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const)
      : {}),
    timeZone: "UTC",
  }).format(date);
}

export function CopyFlagKey({ flagKey }: { flagKey: string }) {
  const [notice, setNotice] = useState<"copied" | "failed" | null>(null);
  const [copying, setCopying] = useState(false);
  const noticeId = useId();

  async function copy() {
    setCopying(true);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(flagKey);
      setNotice("copied");
    } catch {
      setNotice("failed");
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        <code className="min-w-0 break-all font-mono text-xs text-muted">{flagKey}</code>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 sm:h-8 sm:w-8"
          aria-label={`Copy key ${flagKey}`}
          aria-describedby={notice ? noticeId : undefined}
          disabled={copying}
          onClick={copy}
        >
          {notice === "copied" ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
        </Button>
      </div>
      <p
        id={noticeId}
        role="status"
        className={notice === "failed" ? "text-xs text-foreground" : "sr-only"}
      >
        {notice === "copied"
          ? "Key copied."
          : notice === "failed"
            ? "Could not copy. Select the key and copy it manually."
            : ""}
      </p>
    </div>
  );
}

export function EnvironmentStatus({
  environment,
  archived = false,
}: {
  environment?: FlagEnvironmentConfig;
  archived?: boolean;
}) {
  if (!environment) return <span className="text-xs text-muted">Not configured</span>;
  const status = archived
    ? "Archived"
    : !environment.enabled
      ? "Off"
      : environment.rolloutPercent === 0
        ? "On · 0% rollout"
        : environment.rolloutPercent === 100
          ? "On"
          : "Partial rollout";
  const tone =
    archived || !environment.enabled
      ? "text-muted"
      : environment.rolloutPercent === 100
        ? "text-success"
        : "text-warning";
  return (
    <div className="min-w-[124px] space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium">
        <span className={`status-dot ${tone}`} aria-hidden="true" />
        <span>{status}</span>
      </div>
      <div
        className="flex items-center gap-2"
        aria-label={`Configured rollout: ${environment.rolloutPercent} percent`}
      >
        <div className="rollout-track min-w-0 flex-1" aria-hidden="true">
          <div
            className={`h-full ${archived || !environment.enabled ? "bg-muted" : "bg-accent"}`}
            style={{ width: `${environment.rolloutPercent}%` }}
          />
        </div>
        <span className="w-10 text-right text-xs tabular-nums text-muted">
          {environment.rolloutPercent}%
        </span>
      </div>
    </div>
  );
}

export function FlagPagination({
  pagination,
  count,
  loading,
  onPage,
  noun = "flags",
}: {
  pagination: Pagination;
  count: number;
  loading: boolean;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const { page, pageSize, total } = pagination;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = count ? (page - 1) * pageSize + 1 : 0;
  const end = count ? Math.min(total, start + count - 1) : 0;
  return (
    <nav
      aria-label={`${noun} pagination`}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p className="text-xs tabular-nums text-muted">
        {start}–{end} of {total} {noun}
      </p>
      <div className="flex items-center gap-2">
        <Button
          className="min-h-11 sm:min-h-8"
          size="sm"
          disabled={loading || page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label={`Previous page of ${noun}`}
        >
          <ChevronLeft size={14} aria-hidden="true" /> Previous
        </Button>
        <span className="text-xs tabular-nums text-muted">
          {page} / {pages}
        </span>
        <Button
          className="min-h-11 sm:min-h-8"
          size="sm"
          disabled={loading || page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label={`Next page of ${noun}`}
        >
          Next <ChevronRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
