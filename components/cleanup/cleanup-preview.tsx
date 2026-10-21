"use client";

import { useEffect, useRef, useState } from "react";
import { GitPullRequest, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CleanupPreview } from "@/lib/cleanup/fixture";
import { cn } from "@/lib/utils";

export function CleanupPreviewPanel({
  preview,
  onDismiss,
}: {
  preview: CleanupPreview;
  onDismiss: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { review } = preview;
  const manual = review.status === "NEEDS_MANUAL_REVIEW";
  const [prOpening, setPrOpening] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [prSuccess, setPrSuccess] = useState<{
    prNumber: number;
    prTitle: string;
    prUrl: string;
  } | null>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }, [preview]);

  async function handleOpenPr() {
    setPrOpening(true);
    setPrError(null);
    try {
      const response = await fetch("/api/cleanup/open-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagKey: review.flagKey }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Failed to open cleanup pull request.");
      }
      setPrSuccess(body.data);
    } catch (err) {
      setPrError(err instanceof Error ? err.message : "Failed to open cleanup pull request.");
    } finally {
      setPrOpening(false);
    }
  }

  return (
    <section
      aria-labelledby="cleanup-preview-title"
      className="mt-6 min-w-0 rounded-card border border-accent/40 p-4 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            id="cleanup-preview-title"
            ref={heading}
            tabIndex={-1}
            className="scroll-mt-24 text-base font-medium focus-visible:outline-accent"
          >
            Cleanup preview
          </h2>
          <p className="mt-1 text-xs text-muted">Generated fixture · {preview.model}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss cleanup preview"
          onClick={onDismiss}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <code className="font-mono break-all">{review.flagKey}</code>
        <span className="inline-flex items-center gap-2">
          <span
            className={cn("status-dot", manual ? "text-warning" : "text-success")}
            aria-hidden="true"
          />
          {manual ? "Needs manual review" : "Ready for review"}
        </span>
        <span className="num text-muted">Confidence {Math.round(review.confidence * 100)}%</span>
      </div>
      <p className="mt-3 text-sm">{review.explanation}</p>
      {review.reasons.length > 0 && (
        <ul
          className="mt-3 list-disc space-y-1 rounded-control bg-surface py-3 pl-8 pr-4 text-sm"
          aria-label="Safety blockers"
        >
          {review.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <div className="mt-5 space-y-4">
        {review.files.map((file) => (
          <section
            key={file.filePath}
            aria-label={`Diff for ${file.filePath}`}
            className="min-w-0 overflow-hidden rounded-control border border-border"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h3 className="min-w-0 break-all font-mono text-sm font-medium">{file.filePath}</h3>
              <span className="num text-xs text-muted">
                +{file.addedLines} added / −{file.removedLines} removed
              </span>
            </div>
            <pre
              className="overflow-x-auto py-3 text-xs leading-6"
              tabIndex={0}
              aria-label={`Code changes in ${file.filePath}`}
            >
              <code className="font-mono">
                {file.diff.map((line, index) => (
                  <span
                    key={index}
                    className={cn(
                      "block min-w-max px-4",
                      line.kind === "added" && "bg-success/10",
                      line.kind === "removed" && "bg-danger/10",
                    )}
                  >
                    <span aria-hidden="true" className="mr-3 inline-block w-3 select-none">
                      {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                    </span>
                    <span className="sr-only">
                      {line.kind === "context" ? "Unchanged: " : `${line.kind}: `}
                    </span>
                    {line.text || " "}
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>
          </section>
        ))}
      </div>
      <div className="mt-5 border-t border-border pt-4">
        <p className="text-sm">
          Proposed branch: <code className="break-all font-mono text-xs">{preview.branchName}</code>
        </p>
        {prSuccess ? (
          <div className="mt-3 rounded-control border border-success bg-success/10 p-3 text-sm text-success">
            Pull request opened successfully:{" "}
            <a
              href={prSuccess.prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline hover:text-success/80"
            >
              #{prSuccess.prNumber} {prSuccess.prTitle}
            </a>
          </div>
        ) : (
          <p id="cleanup-pr-info" className="mt-2 text-sm text-muted">
            {manual
              ? "This proposal fails the safety gate. Manual review required."
              : "Review the code diff and open the cleanup pull request."}
          </p>
        )}
        {prError ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {prError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {!prSuccess && (
            <Button
              variant="primary"
              disabled={manual || prOpening}
              onClick={() => void handleOpenPr()}
              aria-describedby="cleanup-pr-info"
            >
              <GitPullRequest size={16} aria-hidden="true" />
              {prOpening ? "Opening PR…" : "Open cleanup PR"}
            </Button>
          )}
          <Button variant="ghost" onClick={onDismiss}>
            {prSuccess ? "Close" : "Dismiss preview"}
          </Button>
        </div>
      </div>
    </section>
  );
}
