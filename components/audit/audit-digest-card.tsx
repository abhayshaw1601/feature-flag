"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AuditDigest } from "@/lib/audit/types";
import { AuditRisk, AuditToast, auditText, formatAuditTime } from "./audit-ui";

export type AuditDigestCardProps = {
  digest: AuditDigest;
  compact?: boolean;
  auditHref?: string;
};

export function AuditDigestCard({
  digest,
  compact = false,
  auditHref = "/audit",
}: AuditDigestCardProps) {
  const id = useId();
  const downloads = useRef(new Map<string, number>());
  const [exportError, setExportError] = useState(false);
  const [notice, setNotice] = useState("");
  const dismissNotice = useCallback(() => setNotice(""), []);
  const groups = compact ? digest.groups.slice(0, 2) : digest.groups;
  const shownCount = groups.reduce(
    (count, group) => count + (compact ? Math.min(group.items.length, 3) : group.items.length),
    0,
  );

  useEffect(() => {
    const activeDownloads = downloads.current;
    return () => {
      for (const [url, timer] of activeDownloads) {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      activeDownloads.clear();
    };
  }, []);

  function exportMarkdown() {
    setExportError(false);
    setNotice("");
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      // Always export the supplied digest, including entries hidden by compact presentation.
      url = URL.createObjectURL(
        new Blob([digest.markdown], { type: "text/markdown;charset=utf-8" }),
      );
      link = document.createElement("a");
      link.href = url;
      link.download = `audit-digest-${digest.from.slice(0, 10)}-${digest.to.slice(0, 10)}.md`;
      document.body.appendChild(link);
      link.click();
      setNotice("Markdown download started.");
    } catch {
      setExportError(true);
    } finally {
      link?.remove();
      if (url) {
        const objectUrl = url;
        // Allow the browser to consume the download before releasing its Blob.
        const timer = window.setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
          downloads.current.delete(objectUrl);
        }, 1_000);
        downloads.current.set(objectUrl, timer);
      }
    }
  }

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="min-w-0 rounded-card border border-border bg-surface p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="flex items-center gap-2 text-base font-medium">
            <FileText size={16} className="text-muted" aria-hidden="true" />
            What changed
          </h2>
          <p className="mt-2 text-sm text-muted">
            Deterministic digest from {digest.eventCount} source audit events. Risky changes first.
          </p>
          <p className="mt-2 text-xs text-muted">
            <time dateTime={digest.from}>{formatAuditTime(digest.from)}</time>
            {" to "}
            <time dateTime={digest.to}>{formatAuditTime(digest.to)}</time>
          </p>
          <p className="mt-1 text-xs text-muted">
            Uses the same filters and time window as the audit log, across all pages. No model is
            called to build or export this digest.
          </p>
        </div>
        <Button onClick={exportMarkdown} className="min-h-11 shrink-0">
          <Download size={16} aria-hidden="true" />
          Export Markdown
        </Button>
      </div>

      {digest.truncated ? (
        <p
          role="note"
          className="mt-4 rounded-control border border-warning bg-background p-3 text-sm"
        >
          <span className="font-medium">Digest truncated.</span> Includes {digest.eventCount} of{" "}
          {digest.totalCount} matching events. Narrow the filters or time window for a complete
          digest. The export includes only these supplied events.
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No changes in this scope. Adjust the audit filters to explore another window.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {groups.map((group) => (
            <section
              key={JSON.stringify([group.projectId, group.environmentId])}
              className="rounded-control border border-border bg-background p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 break-words text-sm font-medium">
                  {auditText(group.projectName)} /{" "}
                  {auditText(group.environmentName ?? "Project-wide")}
                </h3>
                {group.risky ? <AuditRisk risky /> : null}
              </div>
              <ul className="mt-3 space-y-3">
                {(compact ? group.items.slice(0, 3) : group.items).map((item) => (
                  <li key={item.eventId} className="space-y-1 text-sm">
                    <p className="whitespace-pre-wrap break-words">{auditText(item.summary)}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      {item.flagKey ? (
                        <code className="break-all font-mono">{auditText(item.flagKey)}</code>
                      ) : null}
                      <time dateTime={item.createdAt}>{formatAuditTime(item.createdAt)}</time>
                      {item.risky ? <AuditRisk risky /> : null}
                    </div>
                    <p className="break-all text-xs text-muted">
                      Source event: <code className="font-mono">{item.eventId}</code>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {compact ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            Showing {shownCount} of {digest.eventCount} included events. Export contains the full
            provided digest.
          </p>
          <a
            href={auditHref}
            className="inline-flex min-h-11 items-center gap-2 rounded-control text-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            View full audit <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </div>
      ) : null}

      {exportError ? (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-danger p-3 text-sm"
        >
          <p>Could not download the Markdown digest.</p>
          <Button onClick={exportMarkdown}>Retry export</Button>
        </div>
      ) : null}
      {notice ? <AuditToast message={notice} onDismiss={dismissNotice} /> : null}
    </section>
  );
}
