"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, History, RefreshCw, Sparkles } from "lucide-react";
import { apiErrorSchema } from "@flagforge/contracts";
import { Button } from "@/components/ui/button";
import type { AuditFilters, AuditOptions, AuditOverview, AuditRow } from "@/lib/audit/types";
import { AuditDigestCard } from "./audit-digest-card";
import {
  AUDIT_BATCH_SIZE,
  AUDIT_PAGE_SIZE,
  AuditRisk,
  AuditToast,
  auditFilterError,
  auditOverviewResponseSchema,
  auditOverviewUrl,
  auditSummaryEventIds,
  auditSummaryResponseSchema,
  auditText,
  auditUtcInput,
  formatAuditTime,
  updateAuditFilters,
} from "./audit-ui";

export type AuditViewProps = {
  workspaceId: string;
  initialData: AuditOverview;
  options: AuditOptions;
  canGenerate: boolean;
  demo?: boolean;
};

const fieldClassName =
  "min-h-11 w-full min-w-0 rounded-control border border-[var(--border-strong)] bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent aria-[invalid=true]:border-danger";

type ActiveRequest = { controller: AbortController; timeoutId: number };

function cancelRequest(ref: { current: ActiveRequest | null }) {
  const request = ref.current;
  ref.current = null;
  if (request) {
    window.clearTimeout(request.timeoutId);
    request.controller.abort();
  }
}

async function responseBody(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  const error = apiErrorSchema.safeParse(body);
  if (error.success)
    throw new Error(
      auditText(error.data.error.message) || "The audit request failed. Please retry.",
    );
  if (!response.ok)
    throw new Error(`The audit request failed (HTTP ${response.status}). Please retry.`);
  return body;
}

function AuditEventRow({ item }: { item: AuditRow }) {
  const sourceLabel = {
    fallback: "Stored summary / fallback",
    ai: "Gemini generated",
    mock: "Mock",
  }[item.summarySource];

  return (
    <li className="min-w-0 space-y-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="break-words font-medium">{auditText(item.projectName)}</span>
          <code className="break-all font-mono text-xs">
            {auditText(item.flagKey ?? item.flagId ?? "No flag")}
          </code>
          <span className="text-muted">
            {auditText(item.environmentName ?? item.environmentKey ?? "Project-wide")}
          </span>
        </div>
        <AuditRisk risky={item.risky} />
      </div>
      <div
        className={`rounded-control border bg-surface p-3 ${item.summarySource === "fallback" ? "border-border" : "border-accent"}`}
      >
        <p className="whitespace-pre-wrap break-words text-sm">{auditText(item.summary)}</p>
        <p className="mt-2 break-words text-xs text-muted">
          <span className="font-medium text-foreground">{sourceLabel}</span>
          {item.summarySource === "fallback"
            ? " · Existing or deterministic text; no model request on read."
            : item.summarySource === "mock"
              ? " · Fixture output, not live Gemini output."
              : " · Previously generated and stored."}
          {item.summarySource !== "fallback" && item.summaryModel
            ? ` Model: ${auditText(item.summaryModel)}.`
            : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="break-words">
          Actor: {auditText(item.actor?.name ?? item.actorName ?? "Unknown actor")}
        </span>
        <span className="break-words">Action: {auditText(item.action)}</span>
        <time dateTime={item.createdAt}>{formatAuditTime(item.createdAt)}</time>
      </div>
      <details className="min-w-0">
        <summary className="w-fit cursor-pointer rounded-control py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          View raw diff<span className="sr-only"> for event {item.id}</span>
        </summary>
        <p className="mt-2 break-all text-xs text-muted">
          Source event: <code className="font-mono">{item.id}</code>
        </p>
        <p className="mt-2 text-xs text-muted">
          Known credential fields are redacted from these snapshots.
        </p>
        <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2">
          {(["before", "after"] as const).map((side) => (
            <div key={side} className="min-w-0">
              <h3 className="mb-2 text-xs font-medium">{side === "before" ? "Before" : "After"}</h3>
              <pre
                tabIndex={0}
                aria-label={`${side === "before" ? "Before" : "After"} JSON for event ${item.id}`}
                className="max-h-80 overflow-auto rounded-control border border-border bg-surface p-3 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {JSON.stringify(item[side], null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}

function AuditLoading() {
  return (
    <div role="status" className="space-y-4">
      <p className="text-sm text-muted">Loading audit events and digest…</p>
      <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
        <div className="space-y-3 rounded-card border border-border bg-surface p-6">
          <div className="skeleton h-5 w-40" />
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-20 w-full" />
        </div>
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-3 rounded-card border border-border p-6">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-5 w-full" />
            <div className="skeleton h-4 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

// A changed workspace/access context unmounts old state and aborts both kinds of requests.
export function AuditView(props: AuditViewProps) {
  return (
    <AuditWorkspace
      key={JSON.stringify([props.workspaceId, props.canGenerate, !!props.demo])}
      {...props}
    />
  );
}

function AuditWorkspace({
  workspaceId,
  initialData,
  options,
  canGenerate,
  demo = false,
}: AuditViewProps) {
  const id = useId();
  const readRequest = useRef<ActiveRequest | null>(null);
  const generationRequest = useRef<ActiveRequest | null>(null);
  const [data, setData] = useState(initialData);
  const [filters, setFilters] = useState<AuditFilters>({
    range: "24h",
    page: initialData.pagination.page,
  });
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const dismissNotice = useCallback(() => setNotice(""), []);
  const validationError = inputError ?? auditFilterError(filters);
  const ready = !loading && !readError && !validationError;
  const summaryIds = ready ? auditSummaryEventIds(data.items) : [];
  const fallbackCount = ready
    ? data.items.filter((item) => item.summarySource === "fallback").length
    : 0;
  const generationDisabled =
    !canGenerate || demo || !workspaceId.trim() || !ready || generating || summaryIds.length === 0;
  const pages = Math.max(1, Math.ceil(data.pagination.total / AUDIT_PAGE_SIZE));

  useEffect(
    () => () => {
      cancelRequest(readRequest);
      cancelRequest(generationRequest);
    },
    [],
  );

  function cancelActiveRequests() {
    cancelRequest(readRequest);
    cancelRequest(generationRequest);
    setLoading(false);
    setGenerating(false);
    setGenerationError(null);
  }

  async function load(nextFilters: AuditFilters) {
    cancelActiveRequests();
    setReadError(null);
    if (auditFilterError(nextFilters)) return;
    if (!workspaceId.trim()) {
      setReadError("Choose a workspace to read its audit log.");
      return;
    }
    setLoading(true);
    const request = { controller: new AbortController(), timeoutId: 0 };
    readRequest.current = request;
    request.timeoutId = window.setTimeout(() => {
      if (readRequest.current !== request) return;
      cancelRequest(readRequest);
      setLoading(false);
      setReadError("Loading the audit log timed out. Please retry.");
    }, 15_000);
    try {
      let body: unknown;
      if (demo) {
        const { filterDemoAudit } = await import("@/lib/audit/demo");
        if (request.controller.signal.aborted) return;
        body = { data: filterDemoAudit(nextFilters) };
      } else {
        body = await responseBody(
          await fetch(auditOverviewUrl(workspaceId, nextFilters), {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: request.controller.signal,
          }),
        );
      }
      const parsed = auditOverviewResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("The audit response was invalid. Please retry.");
      if (readRequest.current === request && !request.controller.signal.aborted) {
        setData(parsed.data.data);
      }
    } catch (cause) {
      if (readRequest.current === request && !request.controller.signal.aborted) {
        setReadError(
          cause instanceof Error && !(cause instanceof TypeError)
            ? auditText(cause.message) || "Could not load the audit log. Please retry."
            : "Could not load the audit log. Check your connection and retry.",
        );
      }
    } finally {
      window.clearTimeout(request.timeoutId);
      if (readRequest.current === request) {
        readRequest.current = null;
        setLoading(false);
      }
    }
  }

  function changeFilters(patch: Partial<Omit<AuditFilters, "page">>) {
    const next = updateAuditFilters(filters, patch);
    setFilters(next);
    setInputError(null);
    setNotice("");
    void load(next);
  }

  function changeDate(key: "from" | "to", value: string) {
    try {
      changeFilters({ [key]: auditUtcInput(value) });
    } catch {
      cancelActiveRequests();
      setInputError("Enter a valid UTC date and time.");
    }
  }

  function resetFilters() {
    const next: AuditFilters = { range: "24h", page: 1 };
    setFilters(next);
    setInputError(null);
    setNotice("");
    void load(next);
  }

  function changePage(page: number) {
    const next = { ...filters, page };
    setFilters(next);
    void load(next);
  }

  async function generate() {
    if (generationDisabled || generationRequest.current) return;
    setGenerating(true);
    setGenerationError(null);
    setNotice("");
    const request = { controller: new AbortController(), timeoutId: 0 };
    generationRequest.current = request;
    request.timeoutId = window.setTimeout(() => {
      if (generationRequest.current !== request) return;
      cancelRequest(generationRequest);
      setGenerating(false);
      setGenerationError(
        "Summary generation timed out. Refresh to check for stored results, or retry.",
      );
    }, 70_000);
    try {
      const body = await responseBody(
        await fetch("/api/ai/audit-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ workspaceId, eventIds: summaryIds }),
          signal: request.controller.signal,
        }),
      );
      const parsed = auditSummaryResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.data.updated > summaryIds.length) {
        throw new Error(
          "The summary response was invalid. Refresh to check for stored results, or retry.",
        );
      }
      if (generationRequest.current !== request || request.controller.signal.aborted) return;
      const { updated, model, mock } = parsed.data.data;
      setNotice(
        `${updated} ${updated === 1 ? "summary" : "summaries"} updated. ${mock ? "Mock" : "Gemini"} output (${auditText(model)}).`,
      );
      // Refresh the owning view's rows and digest together; reads never trigger generation.
      await load(filters);
    } catch (cause) {
      if (generationRequest.current === request && !request.controller.signal.aborted) {
        setGenerationError(
          cause instanceof Error && !(cause instanceof TypeError)
            ? auditText(cause.message) || "Could not generate summaries. Please retry."
            : "Could not generate summaries. Check your connection and retry.",
        );
      }
    } finally {
      window.clearTimeout(request.timeoutId);
      if (generationRequest.current === request) {
        generationRequest.current = null;
        setGenerating(false);
      }
    }
  }

  const projectName = (projectId: string) =>
    options.projects.find((project) => project.id === projectId)?.name ?? projectId;
  const selects = [
    {
      key: "projectId",
      label: "Project",
      all: "All projects",
      choices: options.projects.map((project) => ({ id: project.id, label: project.name })),
    },
    {
      key: "flagId",
      label: "Flag",
      all: "All flags",
      choices: options.flags
        .filter((flag) => !filters.projectId || flag.projectId === filters.projectId)
        .map((flag) => ({
          id: flag.id,
          label: filters.projectId ? flag.key : `${flag.key} · ${projectName(flag.projectId)}`,
        })),
    },
    {
      key: "actorId",
      label: "Actor",
      all: "All actors",
      choices: options.actors.map((actor) => ({ id: actor.id, label: actor.name })),
    },
    {
      key: "environmentId",
      label: "Environment",
      all: "All environments",
      choices: options.environments
        .filter((environment) => !filters.projectId || environment.projectId === filters.projectId)
        .map((environment) => ({
          id: environment.id,
          label: filters.projectId
            ? environment.name
            : `${environment.name} · ${projectName(environment.projectId)}`,
        })),
    },
  ] as const;

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Audit log</h1>
          <p className="mt-2 text-sm text-muted">
            Review changes, their source events, and stored summaries.
          </p>
        </div>
        <Button
          className="min-h-11"
          disabled={loading || generating || !!validationError}
          onClick={() => void load(filters)}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </Button>
      </header>

      {demo ? (
        <aside className="rounded-control border border-border bg-surface p-4 text-sm">
          <span className="font-medium">Local fixture demo.</span> Filters read local fixtures only.
          Summary generation is disabled; no API, database, or model requests are made.
        </aside>
      ) : null}

      <section
        aria-labelledby={`${id}-filters`}
        className="rounded-card border border-border p-4 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-filters`} className="text-base font-medium">
            Filter audit events
          </h2>
          <Button variant="quiet" onClick={resetFilters}>
            Reset filters
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {selects.map((select) => (
            <div key={select.key} className="min-w-0 space-y-2">
              <label htmlFor={`${id}-${select.key}`} className="block text-sm">
                {select.label}
              </label>
              <select
                id={`${id}-${select.key}`}
                name={select.key}
                className={fieldClassName}
                value={filters[select.key] ?? ""}
                onChange={(event) =>
                  changeFilters({ [select.key]: event.target.value || undefined })
                }
              >
                <option value="">{select.all}</option>
                {select.choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {auditText(choice.label)}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="min-w-0 space-y-2">
            <label htmlFor={`${id}-range`} className="block text-sm">
              Time range
            </label>
            <select
              id={`${id}-range`}
              name="range"
              className={fieldClassName}
              value={filters.range}
              aria-describedby={`${id}-dates-help`}
              onChange={(event) =>
                changeFilters({ range: event.target.value as AuditFilters["range"] })
              }
            >
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
            </select>
          </div>
          {(["from", "to"] as const).map((key) => (
            <div key={key} className="min-w-0 space-y-2">
              <label htmlFor={`${id}-${key}`} className="block text-sm">
                {key === "from" ? "From (UTC)" : "To (UTC)"}
              </label>
              <input
                id={`${id}-${key}`}
                name={key}
                type="datetime-local"
                max="9999-12-31T23:59"
                className={fieldClassName}
                value={filters[key]?.slice(0, 16) ?? ""}
                aria-invalid={!!validationError}
                aria-describedby={`${id}-dates-help${validationError ? ` ${id}-dates-error` : ""}`}
                onChange={(event) => changeDate(key, event.target.value)}
              />
            </div>
          ))}
        </div>
        <p id={`${id}-dates-help`} className="mt-3 text-xs text-muted">
          All times are UTC. Optional date bounds override the preset window; choosing a time range
          clears both dates.
        </p>
        {validationError ? (
          <p id={`${id}-dates-error`} role="alert" className="mt-3 text-sm">
            {validationError}
          </p>
        ) : null}
      </section>

      {ready ? <AuditDigestCard digest={data.digest} /> : null}

      <section
        aria-labelledby={`${id}-summaries`}
        className="rounded-card border border-border p-4 sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-64">
            <h2 id={`${id}-summaries`} className="text-base font-medium">
              Event summaries
            </h2>
            <p id={`${id}-generation-help`} className="mt-2 text-sm text-muted">
              {demo
                ? "Generation is disabled in this fixture demo. Displayed summaries are fixture data."
                : !canGenerate
                  ? "Viewer access is read-only. Generating summaries requires Editor access or higher."
                  : !workspaceId.trim()
                    ? "Choose a workspace to generate summaries."
                    : !ready
                      ? "Load a valid audit page before generating summaries."
                      : summaryIds.length === 0
                        ? "All visible events already have generated summaries, or there are no events to summarize."
                        : `Generate summaries for ${summaryIds.length} visible ${summaryIds.length === 1 ? "event" : "events"} with stored or fallback text. Up to ${AUDIT_BATCH_SIZE} events are sent per click.`}
            </p>
            {canGenerate && !demo && fallbackCount > AUDIT_BATCH_SIZE ? (
              <p className="mt-2 text-xs text-muted">
                The first 20 eligible rows are sent. After the automatic refresh, click again for
                the remaining {fallbackCount - AUDIT_BATCH_SIZE} on this page.
              </p>
            ) : null}
            <p className="mt-2 text-xs text-muted">
              Generation runs only on your explicit request. Loading, filtering, and exporting never
              call a model.
            </p>
          </div>
          <Button
            variant="primary"
            className="min-h-11"
            disabled={generationDisabled}
            aria-describedby={`${id}-generation-help`}
            onClick={() => void generate()}
          >
            <Sparkles size={16} aria-hidden="true" />{" "}
            {generating ? "Generating summaries…" : "Generate summaries"}
          </Button>
        </div>
        {generating ? (
          <div role="status" className="mt-4 space-y-3 rounded-control bg-surface p-3">
            <p className="text-sm text-muted">
              Generating and storing summaries. The audit log and digest will refresh when complete.
            </p>
            <div className="space-y-2 motion-safe:animate-pulse" aria-hidden="true">
              <div className="skeleton h-4 w-2/3" />
              <div className="skeleton h-4 w-1/2" />
            </div>
          </div>
        ) : null}
        {generationError ? (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-danger p-3 text-sm"
          >
            <p className="min-w-0 flex-1 basis-64 break-words">{generationError}</p>
            <Button disabled={generationDisabled} onClick={() => void generate()}>
              Retry generation
            </Button>
          </div>
        ) : null}
      </section>

      <div aria-busy={loading} className="space-y-6">
        {loading ? (
          <AuditLoading />
        ) : readError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger p-4 text-sm"
          >
            <p className="min-w-0 flex-1 basis-64 break-words">{readError}</p>
            <Button onClick={() => void load(filters)} disabled={!!validationError}>
              Retry
            </Button>
          </div>
        ) : ready ? (
          <section
            aria-labelledby={`${id}-events`}
            className="min-w-0 rounded-card border border-border"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4 sm:px-6">
              <h2 id={`${id}-events`} className="text-base font-medium">
                Source events
              </h2>
              <p className="text-xs text-muted">
                {data.pagination.total} matching events · {AUDIT_PAGE_SIZE} per page
              </p>
            </div>
            {data.items.length === 0 ? (
              <div className="space-y-3 p-6">
                <History size={24} className="text-muted" aria-hidden="true" />
                <p className="text-sm">
                  No audit events match these filters. Reset them to explore the last 24 hours.
                </p>
                <Button variant="primary" className="min-h-11" onClick={resetFilters}>
                  Reset filters
                </Button>
              </div>
            ) : (
              <ol className="divide-y divide-border">
                {data.items.map((item) => (
                  <AuditEventRow key={item.id} item={item} />
                ))}
              </ol>
            )}
            <nav
              aria-label="Audit events pagination"
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4"
            >
              <p className="text-xs tabular-nums text-muted">
                {data.items.length ? (data.pagination.page - 1) * AUDIT_PAGE_SIZE + 1 : 0}–
                {data.items.length
                  ? Math.min(
                      data.pagination.total,
                      (data.pagination.page - 1) * AUDIT_PAGE_SIZE + data.items.length,
                    )
                  : 0}{" "}
                of {data.pagination.total} events
              </p>
              <div className="flex items-center gap-2">
                <Button
                  className="min-h-11"
                  disabled={data.pagination.page <= 1 || generating}
                  onClick={() => changePage(data.pagination.page - 1)}
                  aria-label="Previous page of audit events"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                  Previous
                </Button>
                <span className="text-xs tabular-nums text-muted">
                  Page {data.pagination.page} of {pages}
                </span>
                <Button
                  className="min-h-11"
                  disabled={data.pagination.page >= pages || generating}
                  onClick={() => changePage(data.pagination.page + 1)}
                  aria-label="Next page of audit events"
                >
                  Next
                  <ChevronRight size={16} aria-hidden="true" />
                </Button>
              </div>
            </nav>
          </section>
        ) : null}
      </div>
      {notice ? <AuditToast message={notice} onDismiss={dismissNotice} /> : null}
    </div>
  );
}
