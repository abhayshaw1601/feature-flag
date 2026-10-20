"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCcw } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { z } from "zod";
import {
  auditEventSchema,
  auditQuerySchema,
  flagDetailSchema,
  paginationSchema,
  type AuditEvent,
  type FlagDetail,
  type FlagEnvironmentConfig,
  type Pagination,
  type RuleOperator,
} from "@flagforge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { auditFieldChanges, readableField, readableValue } from "./audit-diff";
import {
  CopyFlagKey,
  EnvironmentStatus,
  FlagPagination,
  formatFlagDate,
  typeLabels,
} from "./flag-ui";
import { useFlagResource } from "./use-flag-resource";

export type FlagDetailViewProps = {
  flag: FlagDetail;
  initialHistory: { items: AuditEvent[]; pagination: Pagination };
};

const historySchema = z.object({ items: z.array(auditEventSchema), pagination: paginationSchema });
const tabs = ["Targeting", "History", "Settings"] as const;
type Tab = (typeof tabs)[number];
const operatorLabels: Record<RuleOperator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  in: "is one of",
  not_in: "is not one of",
  contains: "contains",
  starts_with: "starts with",
  greater_than: "is greater than",
  less_than: "is less than",
};

export function FlagDetailView(props: FlagDetailViewProps) {
  return <FlagDetailContent key={props.flag.id} {...props} />;
}

function FlagDetailContent({ flag: initialFlag, initialHistory }: FlagDetailViewProps) {
  const [tab, setTab] = useState<Tab>("Targeting");
  const id = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const {
    data: flag,
    loading,
    error,
    refresh,
  } = useFlagResource(
    `/api/flags/${encodeURIComponent(initialFlag.id)}`,
    initialFlag,
    flagDetailSchema,
  );

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next]);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="min-w-0 space-y-6">
      <header className="space-y-4">
        <Link
          href="/"
          className="inline-flex min-h-9 items-center gap-2 text-sm text-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          Back to flags
        </Link>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0 space-y-2">
            <h1 className="break-words text-2xl font-medium tracking-[-0.02em]">{flag.name}</h1>
            <CopyFlagKey flagKey={flag.key} />
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge>{typeLabels[flag.type]}</Badge>
              {flag.archivedAt ? <Badge>Archived</Badge> : null}
              <span className="break-words">{flag.project.name}</span>
            </div>
            {flag.description ? (
              <p className="max-w-3xl whitespace-pre-wrap break-words text-sm text-muted">
                {flag.description}
              </p>
            ) : null}
          </div>
          <Button
            className="min-h-11 shrink-0 self-start sm:min-h-9"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCcw
              size={15}
              className={loading ? "animate-spin motion-reduce:animate-none" : undefined}
              aria-hidden="true"
            />
            {loading ? "Refreshing…" : "Refresh flag"}
          </Button>
        </div>
        <p role="status" className="text-xs text-muted">
          {loading ? (
            "Refreshing saved configuration…"
          ) : (
            <>
              Updated <time dateTime={flag.updatedAt}>{formatFlagDate(flag.updatedAt, true)}</time>
            </>
          )}
        </p>
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border p-3"
          >
            <p className="text-sm">
              Could not refresh this flag. {error} Showing the last loaded configuration.
            </p>
            <Button size="sm" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : null}
      </header>

      <div
        role="tablist"
        aria-label="Flag details"
        className="flex overflow-x-auto border-b border-border"
      >
        {tabs.map((name, index) => (
          <button
            key={name}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${name}`}
            aria-controls={`${id}-panel-${name}`}
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            onKeyDown={(event) => navigateTabs(event, index)}
            onClick={() => setTab(name)}
            className={`min-h-11 shrink-0 border-b-2 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${tab === name ? "border-accent font-medium text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel-Targeting`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-Targeting`}
        hidden={tab !== "Targeting"}
        tabIndex={0}
        className="min-w-0 outline-accent"
      >
        <Targeting flag={flag} />
      </div>
      <div
        id={`${id}-panel-History`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-History`}
        hidden={tab !== "History"}
        tabIndex={0}
        className="min-w-0 outline-accent"
      >
        <FlagHistory flagId={flag.id} projectId={flag.projectId} initialHistory={initialHistory} />
      </div>
      <div
        id={`${id}-panel-Settings`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-Settings`}
        hidden={tab !== "Settings"}
        tabIndex={0}
        className="min-w-0 outline-accent"
      >
        <Settings flag={flag} />
      </div>
    </div>
  );
}

function Targeting({ flag }: { flag: FlagDetail }) {
  return (
    <section className="space-y-4" aria-label="Saved targeting">
      <div>
        <h2 className="text-base font-medium">Environment comparison</h2>
        <p className="mt-1 text-sm text-muted">
          Saved targeting is read-only. Targeting and rollout editing are deferred.
        </p>
        {flag.archivedAt ? (
          <p className="mt-2 text-sm">
            This flag is archived. These are its saved environment settings.
          </p>
        ) : null}
      </div>
      {flag.environments.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-5 text-sm text-muted">
          No environment configuration is saved for this flag.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-card border border-border bg-surface">
            <table className="w-full min-w-[640px] text-left text-sm">
              <caption className="sr-only">
                Saved environment settings. Configured rollout is not a measured exposure rate;
                rules may override it.
              </caption>
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  <th scope="col" className="sticky left-0 z-10 bg-surface px-4 py-3 font-medium">
                    Environment
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Enabled
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status / rollout
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Default serve
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Rules
                  </th>
                </tr>
              </thead>
              <tbody>
                {flag.environments.map((environment) => (
                  <tr
                    key={environment.environmentId}
                    className="border-b border-border last:border-b-0"
                  >
                    <th scope="row" className="sticky left-0 bg-surface px-4 py-4 font-medium">
                      {readableField(environment.environmentKey)}
                    </th>
                    <td className="px-4 py-4">{environment.enabled ? "Enabled" : "Disabled"}</td>
                    <td className="px-4 py-4">
                      <EnvironmentStatus
                        environment={environment}
                        archived={Boolean(flag.archivedAt)}
                      />
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">
                      {environment.rules.defaultServe.rolloutPercent}%
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">
                      {environment.rules.rules.length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            Percentages are saved rollout settings, not measured exposure. Disabled environments
            serve their off value; matching rules may override the default serve.
          </p>
          <div className="space-y-4">
            {flag.environments.map((environment) => (
              <EnvironmentRules key={environment.environmentId} environment={environment} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function EnvironmentRules({ environment }: { environment: FlagEnvironmentConfig }) {
  const rules = environment.rules.rules;
  return (
    <section className="min-w-0 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{readableField(environment.environmentKey)} rules</h3>
        <p className="text-xs tabular-nums text-muted">
          Version {environment.version} ·{" "}
          <time dateTime={environment.updatedAt}>
            {formatFlagDate(environment.updatedAt, true)}
          </time>
        </p>
      </div>
      {rules.length ? (
        <ol className="mt-3 divide-y divide-border">
          {rules.map((rule, index) => (
            <li className="py-3 first:pt-0 last:pb-0" key={rule.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words text-sm font-medium">
                  {index + 1}. {rule.description}
                </p>
                <span className="shrink-0 text-xs tabular-nums">
                  Serve {rule.serve.rolloutPercent}%
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">When all conditions match:</p>
              <ul className="mt-2 space-y-1">
                {rule.conditions.map((condition, conditionIndex) => (
                  <li className="break-words text-sm" key={conditionIndex}>
                    <code className="font-mono text-xs">{condition.attribute}</code>{" "}
                    {operatorLabels[condition.operator]}{" "}
                    <code className="whitespace-pre-wrap break-all font-mono text-xs">
                      {condition.values.map((value) => JSON.stringify(value)).join(", ")}
                    </code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-muted">
          No targeting rules. Default serve is {environment.rules.defaultServe.rolloutPercent}% when
          enabled.
        </p>
      )}
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer rounded-control py-1 text-muted underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-accent">
          Saved on / off values
        </summary>
        <dl className="mt-2 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="mb-1 text-xs text-muted">On value</dt>
            <dd>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control border border-border bg-background p-3 font-mono text-xs">
                {JSON.stringify(environment.onValue, null, 2)}
              </pre>
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-xs text-muted">Off value</dt>
            <dd>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control border border-border bg-background p-3 font-mono text-xs">
                {JSON.stringify(environment.offValue, null, 2)}
              </pre>
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function FlagHistory({
  flagId,
  projectId,
  initialHistory,
}: {
  flagId: string;
  projectId: string;
  initialHistory: FlagDetailViewProps["initialHistory"];
}) {
  const [page, setPage] = useState(initialHistory.pagination.page);
  const query = auditQuerySchema.parse({
    flagId,
    projectId,
    page,
    pageSize: initialHistory.pagination.pageSize,
  });
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, String(value));
  });
  const { data, loading, error, refresh } = useFlagResource(
    `/api/audit?${params}`,
    initialHistory,
    historySchema,
  );

  useEffect(() => {
    if (loading || error) return;
    const lastPage = Math.max(1, Math.ceil(data.pagination.total / data.pagination.pageSize));
    if (data.pagination.page > lastPage) setPage(lastPage);
  }, [data, loading, error]);

  return (
    <section
      className="min-w-0 rounded-card border border-border bg-surface"
      aria-label="Flag history"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="text-base font-medium">History</h2>
          <p role="status" className="mt-1 text-xs text-muted">
            {loading ? "Loading history…" : `${data.pagination.total} audit events`}
            {loading && data.items.length ? " Showing last loaded events." : ""}
          </p>
        </div>
        <Button className="min-h-11 sm:min-h-9" onClick={refresh} disabled={loading}>
          <RefreshCcw
            size={15}
            className={loading ? "animate-spin motion-reduce:animate-none" : undefined}
            aria-hidden="true"
          />
          Refresh history
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4"
        >
          <p className="text-sm">
            Could not load history. {error}
            {data.items.length ? " Showing last loaded events." : ""}
          </p>
          <Button size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      <div aria-busy={loading}>
        {!data.items.length && loading ? (
          <div role="status" className="space-y-5 p-4">
            <span className="sr-only">Loading history…</span>
            {[0, 1, 2].map((index) => (
              <div key={index} aria-hidden="true" className="flex gap-3">
                <span className="skeleton h-8 w-8 shrink-0" />
                <div className="flex-1 space-y-2">
                  <span className="skeleton block h-4 w-2/3" />
                  <span className="skeleton block h-4 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : !data.items.length && !error ? (
          <p className="p-5 text-sm text-muted">
            No audit events have been recorded for this flag.
          </p>
        ) : (
          <ol className="divide-y divide-border">
            {data.items.map((event) => (
              <AuditRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </div>
      <FlagPagination
        pagination={data.pagination}
        count={data.items.length}
        loading={loading}
        onPage={setPage}
        noun="events"
      />
    </section>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  const actor = event.actor?.name || event.actorName || "System";
  const initials =
    actor
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0] ?? "")
      .join("")
      .toUpperCase() || "?";
  const changes = auditFieldChanges(event.before, event.after);
  return (
    <li className="min-w-0 p-4">
      <article className="min-w-0">
        <div className="flex items-start gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium"
            aria-hidden="true"
          >
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="break-words text-sm font-medium">{actor}</p>
              <time className="text-xs tabular-nums text-muted" dateTime={event.createdAt}>
                {formatFlagDate(event.createdAt, true)}
              </time>
            </div>
            <p className="mt-1 break-words text-sm">{event.summary}</p>
            <p className="mt-1 break-words text-xs text-muted">
              {readableField(event.action)}
              {event.environmentId ? ` · Environment ${event.environmentId}` : ""}
            </p>
          </div>
        </div>
        {changes.length ? (
          <div className="mt-3 overflow-x-auto rounded-control border border-border bg-background">
            <table className="w-full table-fixed text-left text-xs">
              <caption className="sr-only">Field changes: {event.summary}</caption>
              <thead>
                <tr className="border-b border-border text-muted">
                  <th scope="col" className="w-1/4 px-3 py-2 font-medium">
                    Field
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Before
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    After
                  </th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.field} className="border-b border-border last:border-b-0">
                    <th scope="row" className="break-words px-3 py-2 align-top font-medium">
                      {readableField(change.field)}
                    </th>
                    <td className="whitespace-pre-wrap break-all px-3 py-2 align-top text-muted">
                      {readableValue(change.before)}
                    </td>
                    <td className="whitespace-pre-wrap break-all px-3 py-2 align-top">
                      {readableValue(change.after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted">
            {event.before === null && event.after === null
              ? "No before / after snapshot was recorded."
              : "No field values changed in this snapshot."}
          </p>
        )}
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer rounded-control py-1 text-muted underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-accent">
            Raw event JSON
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-control border border-border bg-background p-3 font-mono text-xs">
            {JSON.stringify(event, null, 2)}
          </pre>
        </details>
      </article>
    </li>
  );
}

function MetadataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-4 first:pt-0 last:pb-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-sm">{children}</dd>
    </div>
  );
}

function Settings({ flag }: { flag: FlagDetail }) {
  return (
    <section
      className="rounded-card border border-border bg-surface p-4"
      aria-label="Saved flag metadata"
    >
      <h2 className="text-base font-medium">Saved metadata</h2>
      <p className="mt-1 text-sm text-muted">
        Read-only. Metadata editing and archive actions are deferred.
      </p>
      <dl className="mt-5 divide-y divide-border">
        <MetadataRow label="Name">{flag.name}</MetadataRow>
        <MetadataRow label="Key">
          <code className="break-all font-mono text-xs">{flag.key}</code>
        </MetadataRow>
        <MetadataRow label="Project">{flag.project.name}</MetadataRow>
        <MetadataRow label="Type">{typeLabels[flag.type]}</MetadataRow>
        <MetadataRow label="Description">{flag.description || "No description"}</MetadataRow>
        <MetadataRow label="Owner">{flag.owner?.name ?? "Unassigned"}</MetadataRow>
        <MetadataRow label="Tags">
          {flag.tags.length ? (
            <div className="flex flex-wrap gap-2">
              {flag.tags.map((tag, index) => (
                <Badge key={`${tag}-${index}`} className="max-w-full break-all">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : (
            "No tags"
          )}
        </MetadataRow>
        <MetadataRow label="Status">{flag.archivedAt ? "Archived" : "Active"}</MetadataRow>
        <MetadataRow label="Created">
          <time dateTime={flag.createdAt}>{formatFlagDate(flag.createdAt, true)}</time>
        </MetadataRow>
        <MetadataRow label="Updated">
          <time dateTime={flag.updatedAt}>{formatFlagDate(flag.updatedAt, true)}</time>
        </MetadataRow>
        {flag.archivedAt ? (
          <MetadataRow label="Archived">
            <time dateTime={flag.archivedAt}>{formatFlagDate(flag.archivedAt, true)}</time>
          </MetadataRow>
        ) : null}
      </dl>
    </section>
  );
}
