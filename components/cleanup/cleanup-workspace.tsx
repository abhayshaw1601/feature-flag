"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { FileCode2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CleanupPreviewPanel } from "./cleanup-preview";
import { RepositoriesPanel } from "./repositories-panel";
import type { CleanupPreview, CleanupScan } from "@/lib/cleanup/fixture";
import { cn } from "@/lib/utils";

async function requestFixture<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "The fixture request failed.");
  return body.data as T;
}

function CandidateList({
  candidates,
  busy,
  onGenerate,
}: {
  candidates: CleanupScan["candidates"];
  busy: boolean;
  onGenerate: (key: string) => void;
}) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {candidates.map((candidate) => (
        <li
          key={candidate.flagKey}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">{candidate.flagName}</p>
            <code className="mt-1 block break-all font-mono text-xs text-muted">
              {candidate.flagKey}
            </code>
            <p className="mt-2 text-sm text-muted">
              {candidate.reason === "ON_EVERYWHERE"
                ? "100% on in all environments"
                : "Off in all environments"}
            </p>
          </div>
          <div className="num text-right text-sm">
            <p>{candidate.daysStale} days unchanged</p>
            <p className="mt-1 text-sm text-muted">
              {candidate.referenceCount}{" "}
              {candidate.referenceCount === 1 ? "reference" : "references"}
            </p>
          </div>
          <Button
            id={`preview-${candidate.flagKey}`}
            className="col-span-2 min-h-11 justify-self-start sm:col-span-1 sm:min-h-9 sm:justify-self-end"
            onClick={() => onGenerate(candidate.flagKey)}
            disabled={busy}
            aria-label={`Preview cleanup for ${candidate.flagKey}`}
          >
            Preview cleanup
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function CleanupWorkspace({
  initialScan,
  view,
  demo = false,
}: {
  initialScan: CleanupScan;
  view: "repositories" | "stale";
  demo?: boolean;
}) {
  const [scan, setScan] = useState(initialScan);
  const [onDays, setOnDays] = useState(String(initialScan.thresholds.onDays));
  const [offDays, setOffDays] = useState(String(initialScan.thresholds.offDays));
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);
  const [notice, setNotice] = useState("");
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function rescan() {
    setBusy(true);
    setError(null);
    setNotice("");
    setPreview(null);
    try {
      const query = new URLSearchParams({ onDays, offDays });
      const result = await requestFixture<CleanupScan>(`/api/cleanup/demo?${query}`);
      setScan(result);
      setNotice("Fixture scan complete. No repository data was changed.");
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : "Could not scan the fixture.",
        retry: () => void rescan(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function generate(flagKey: string) {
    setBusy(true);
    setLoadingKey(flagKey);
    setPreview(null);
    setError(null);
    setNotice("");
    try {
      const result = await requestFixture<CleanupPreview>("/api/cleanup/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagKey, ...scan.thresholds }),
      });
      setPreview(result);
      setNotice("Fixture preview ready. Review the diff; nothing has been applied.");
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : "Could not generate the preview.",
        retry: () => void generate(flagKey),
      });
    } finally {
      setBusy(false);
      setLoadingKey(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void rescan();
  }

  const candidates = scan.candidates.filter((candidate) =>
    `${candidate.flagKey} ${candidate.flagName}`.toLowerCase().includes(search.toLowerCase()),
  );
  const repositoriesHref = demo ? "/demo/cleanup?view=repositories" : "/repositories";
  const staleHref = demo ? "/demo/cleanup" : "/stale-flags";

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-medium tracking-[-0.02em]">
          {view === "repositories" ? "Repositories" : "Stale flags"}
        </h1>
        {view === "stale" && (
          <Button className="min-h-11 sm:min-h-9" onClick={() => void rescan()} disabled={busy}>
            <RefreshCw size={16} aria-hidden="true" />
            {busy && !loadingKey ? "Scanning…" : "Rescan"}
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {view === "repositories"
          ? "Find the flag calls that are still in your code."
          : "Review the code left behind by completed rollouts."}
      </p>
      <nav aria-label="Cleanup views" className="mt-6 flex gap-6 border-b border-border text-sm">
        {[
          ["repositories", "Repositories", repositoriesHref],
          ["stale", "Stale flags", staleHref],
        ].map(([key, label, href]) => (
          <Link
            key={key}
            href={href}
            aria-current={view === key ? "page" : undefined}
            className={cn(
              "border-b-2 py-3",
              view === key
                ? "border-foreground font-medium"
                : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
      <aside
        className="my-6 rounded-control bg-surface px-4 py-3 text-sm"
        aria-label="Fixture mode"
      >
        <p>
          <span className="font-medium">Fixture mode.</span> Synthetic data only. No Gemini or
          GitHub calls, writes, or PRs.
        </p>
        <p className="mt-1 text-xs text-muted">
          Snapshot: {scan.asOf.slice(0, 10)} · All environments
        </p>
      </aside>
      {error && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-border px-4 py-3 text-sm"
        >
          <p>{error.message}</p>
          <Button onClick={error.retry} disabled={busy}>
            Retry
          </Button>
        </div>
      )}
      {view === "repositories" ? (
        <RepositoriesPanel scan={scan} busy={busy} onScan={() => void rescan()} />
      ) : (
        <>
          <details
            open={thresholdsOpen}
            onToggle={(event) => setThresholdsOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer rounded-control text-sm focus-visible:outline-accent">
              Age thresholds: {scan.thresholds.onDays} days on / {scan.thresholds.offDays} days off
            </summary>
            <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3 text-sm">
              <label className="grid gap-2">
                On everywhere for (days)
                <input
                  className="num h-10 w-36 rounded-control border border-border-strong bg-background px-3"
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  required
                  value={onDays}
                  disabled={busy}
                  onChange={(event) => setOnDays(event.target.value)}
                />
              </label>
              <label className="grid gap-2">
                Off everywhere for (days)
                <input
                  className="num h-10 w-36 rounded-control border border-border-strong bg-background px-3"
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  required
                  value={offDays}
                  disabled={busy}
                  onChange={(event) => setOffDays(event.target.value)}
                />
              </label>
              <Button type="submit" disabled={busy} className="min-h-10">
                Apply thresholds
              </Button>
            </form>
          </details>
          <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-3">
            <label className="relative block w-full sm:w-72">
              <span className="sr-only">Search stale flags</span>
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-3 text-muted"
                aria-hidden="true"
              />
              <input
                className="h-10 w-full rounded-control border border-border-strong bg-background pl-9 pr-3 text-sm placeholder:text-muted"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name or key"
              />
            </label>
            <p className="num text-sm text-muted">
              {candidates.length} of {scan.candidates.length} candidates
            </p>
          </div>
          {/* Candidate rows and their evidence share one full-width grid; no summary tiles. */}
          <div aria-busy={busy}>
            {candidates.length === 0 ? (
              <div className="rounded-card border border-border p-6">
                <FileCode2 size={24} className="mb-3 text-muted" aria-hidden="true" />
                <p className="text-sm">
                  {search
                    ? "No candidates match your search."
                    : "No referenced flags meet these age thresholds."}
                </p>
                <Button
                  className="mt-4"
                  onClick={() => {
                    if (search) setSearch("");
                    else {
                      setOnDays("30");
                      setOffDays("60");
                      setThresholdsOpen(true);
                    }
                  }}
                >
                  {search ? "Clear search" : "Restore default inputs"}
                </Button>
              </div>
            ) : (
              <CandidateList
                candidates={candidates}
                busy={busy}
                onGenerate={(key) => void generate(key)}
              />
            )}
          </div>
          {loadingKey && (
            <div role="status" className="mt-6 rounded-card border border-border p-6">
              <p className="text-sm">Preparing fixture diff for {loadingKey}…</p>
              <div className="mt-4 space-y-3" aria-hidden="true">
                <div className="skeleton h-4 w-3/4" />
                <div className="skeleton h-4 w-full" />
                <div className="skeleton h-4 w-1/2" />
              </div>
            </div>
          )}
          {preview && (
            <CleanupPreviewPanel
              preview={preview}
              onDismiss={() => {
                setPreview(null);
                document.getElementById(`preview-${preview.review.flagKey}`)?.focus();
              }}
            />
          )}
          <p className="mt-6 text-xs leading-5 text-muted">
            Safety gate: confidence at least 80%, no more than 40 added and removed lines per file,
            and exact source-file coverage. These checks do not prove semantic correctness.
          </p>
        </>
      )}
      {notice && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-control border border-border bg-background px-4 py-3 text-sm sm:max-w-md"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
