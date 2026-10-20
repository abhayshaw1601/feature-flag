"use client";

import Link from "next/link";
import { Check, Plus, RefreshCcw, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  listFlagsQuerySchema,
  listFlagsResponseSchema,
  type FlagSummary,
  type ListFlagsQuery,
  type ListFlagsResponse,
} from "@flagforge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreateFlagDialog } from "./create-flag-dialog";
import {
  CopyFlagKey,
  EnvironmentStatus,
  FlagPagination,
  fieldClassName,
  formatFlagDate,
  primaryActionClassName,
  typeLabels,
} from "./flag-ui";
import { useFlagResource } from "./use-flag-resource";

export type FlagsPageProps = {
  initialData: ListFlagsResponse;
  project: { id: string; name: string };
  members: Array<{ id: string; name: string }>;
  canCreate: boolean;
  environments: Array<{ key: string; name: string }>;
};

function FlagIdentity({ flag }: { flag: FlagSummary }) {
  return (
    <div className="min-w-0">
      <Link
        href={`/flags/${encodeURIComponent(flag.id)}`}
        className="break-words text-sm font-medium underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-accent"
      >
        {flag.name}
      </Link>
      <CopyFlagKey flagKey={flag.key} />
      {flag.archivedAt ? <Badge>Archived</Badge> : null}
    </div>
  );
}

export function FlagsSkeleton() {
  return (
    <div className="space-y-5 p-4" role="status" aria-label="Loading flags">
      <span className="sr-only">Loading flags…</span>
      {Array.from({ length: 5 }, (_, index) => (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" key={index} aria-hidden="true">
          <span className="skeleton h-10 w-full" />
          <span className="skeleton h-10 w-full" />
          <span className="skeleton hidden h-10 w-full sm:block" />
          <span className="skeleton hidden h-10 w-full sm:block" />
        </div>
      ))}
    </div>
  );
}

// Keying the scope prevents project switches from briefly showing another project's flags or draft.
export function FlagsPage(props: FlagsPageProps) {
  return <ProjectFlags key={props.project.id} {...props} />;
}

function ProjectFlags({ initialData, project, members, canCreate, environments }: FlagsPageProps) {
  const [query, setQuery] = useState<ListFlagsQuery>(() =>
    listFlagsQuerySchema.parse({
      page: initialData.pagination.page,
      pageSize: initialData.pagination.pageSize,
    }),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<FlagSummary | null>(null);
  const createActionsRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const params = new URLSearchParams();
  const parsedQuery = listFlagsQuerySchema.parse(query);
  Object.entries(parsedQuery).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const { data, loading, error, refresh } = useFlagResource(
    `/api/projects/${encodeURIComponent(project.id)}/flags?${params}`,
    initialData,
    listFlagsResponseSchema,
  );

  useEffect(() => {
    if (!created) return;
    // The empty-state opener disappears once the first flag arrives. The header
    // action is a stable focus destination after a successful creation.
    createActionsRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.focus();
    const timeout = window.setTimeout(() => setCreated(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [created]);

  useEffect(() => {
    if (loading || error) return;
    const lastPage = Math.max(1, Math.ceil(data.pagination.total / data.pagination.pageSize));
    if (data.pagination.page > lastPage) setQuery((previous) => ({ ...previous, page: lastPage }));
  }, [data, loading, error]);

  function changeQuery(next: Partial<ListFlagsQuery>) {
    setQuery((previous) => ({ ...previous, ...next, page: 1 }));
  }

  const filtered = Boolean(query.search?.trim() || query.type || query.status !== "active");
  const hasRows = data.items.length > 0;

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium tracking-[-0.02em]">Flags</h1>
          <p className="mt-2 break-words text-sm text-muted">Feature flags in {project.name}.</p>
          {!canCreate ? (
            <p className="mt-2 text-xs text-muted">
              Viewer access is read-only. Ask a project editor or admin to create a flag.
            </p>
          ) : null}
        </div>
        <div ref={createActionsRef} className="flex shrink-0 items-center gap-2">
          <Button className="min-h-11 sm:min-h-9" onClick={refresh} disabled={loading}>
            <RefreshCcw
              size={15}
              className={loading ? "animate-spin motion-reduce:animate-none" : undefined}
              aria-hidden="true"
            />
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          {canCreate ? (
            <Button
              variant="primary"
              className={primaryActionClassName}
              aria-haspopup="dialog"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={16} aria-hidden="true" /> Create flag
            </Button>
          ) : null}
        </div>
      </header>

      <section
        className="min-w-0 rounded-card border border-border bg-surface"
        aria-labelledby={headingId}
      >
        <div className="space-y-4 border-b border-border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={headingId} className="text-base font-medium">
              Environment comparison
            </h2>
            <p role="status" className="text-xs tabular-nums text-muted">
              {loading
                ? "Updating results…"
                : `${data.pagination.total} ${error ? "last loaded " : filtered ? "matching " : "active "}flags`}
              {loading && hasRows ? " Showing last loaded results." : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="relative min-w-0 basis-full sm:min-w-[220px] sm:flex-1 sm:basis-auto">
              <span className="sr-only">Search flags by name or key</span>
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                className={`${fieldClassName} min-h-11 pl-9 sm:min-h-9`}
                type="search"
                name="flag-search"
                autoComplete="off"
                maxLength={100}
                placeholder="Search by name or key…"
                value={query.search ?? ""}
                onChange={(event) => changeQuery({ search: event.target.value })}
              />
            </label>
            <label className="min-w-0 flex-1 space-y-1 sm:flex-none">
              <span className="block text-xs text-muted">Type</span>
              <select
                className={`${fieldClassName} min-h-11 sm:min-h-9`}
                value={query.type ?? "all"}
                onChange={(event) =>
                  changeQuery({
                    type:
                      event.target.value === "all"
                        ? undefined
                        : (event.target.value as ListFlagsQuery["type"]),
                  })
                }
              >
                <option value="all">All types</option>
                {Object.entries(typeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 flex-1 space-y-1 sm:flex-none">
              <span className="block text-xs text-muted">Status</span>
              <select
                className={`${fieldClassName} min-h-11 sm:min-h-9`}
                value={query.status}
                onChange={(event) =>
                  changeQuery({ status: event.target.value as ListFlagsQuery["status"] })
                }
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="min-w-0 flex-1 space-y-1 sm:flex-none">
              <span className="block text-xs text-muted">Sort</span>
              <select
                className={`${fieldClassName} min-h-11 sm:min-h-9`}
                value={query.sort}
                onChange={(event) =>
                  changeQuery({ sort: event.target.value as ListFlagsQuery["sort"] })
                }
              >
                <option value="updatedAt">Updated</option>
                <option value="name">Name</option>
                <option value="key">Key</option>
              </select>
            </label>
          </div>
        </div>

        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4"
          >
            <p className="text-sm">
              Could not load flags. {error}
              {hasRows ? " Showing last loaded results." : ""}
            </p>
            <Button size="sm" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : null}

        <div aria-busy={loading}>
          {!hasRows && loading ? (
            <FlagsSkeleton />
          ) : !hasRows && !error ? (
            <div className="space-y-3 px-4 py-10 text-center">
              <h3 className="text-base font-medium">
                {filtered ? "No flags match these filters" : "No active flags yet"}
              </h3>
              <p className="text-sm text-muted">
                {filtered
                  ? "Try another search, type, or status."
                  : "Create a flag to start managing a feature across environments."}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {filtered ? (
                  <Button
                    onClick={() =>
                      setQuery(listFlagsQuerySchema.parse({ pageSize: query.pageSize }))
                    }
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button onClick={() => changeQuery({ status: "all" })}>View all statuses</Button>
                )}
                {canCreate ? (
                  <Button onClick={() => setCreateOpen(true)}>Create flag</Button>
                ) : (
                  <p className="w-full text-xs text-muted">
                    An editor or admin can create the first flag.
                  </p>
                )}
              </div>
            </div>
          ) : hasRows ? (
            <>
              <div className="hidden max-h-[65vh] overflow-auto md:block">
                <table className="w-full min-w-[800px] border-collapse text-left">
                  <caption className="sr-only">
                    Feature flags and configured rollout by environment. Off and archived flags do
                    not serve their configured rollout.
                  </caption>
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className="border-b border-border text-xs text-muted">
                      <th
                        className="sticky left-0 z-10 w-[26%] min-w-[220px] bg-surface px-4 py-3 font-medium"
                        scope="col"
                      >
                        Flag
                      </th>
                      <th className="px-4 py-3 font-medium" scope="col">
                        Type
                      </th>
                      {environments.map((environment) => (
                        <th className="px-4 py-3 font-medium" scope="col" key={environment.key}>
                          {environment.name}
                        </th>
                      ))}
                      <th className="px-4 py-3 font-medium" scope="col">
                        Owner
                      </th>
                      <th className="px-4 py-3 text-right font-medium" scope="col">
                        Updated
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((flag) => (
                      <tr className="border-b border-border last:border-b-0" key={flag.id}>
                        <td className="sticky left-0 bg-surface px-4 py-3 align-top">
                          <FlagIdentity flag={flag} />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <Badge className="whitespace-nowrap">{typeLabels[flag.type]}</Badge>
                        </td>
                        {environments.map((environment) => (
                          <td className="px-4 py-3 align-top" key={environment.key}>
                            <EnvironmentStatus
                              environment={flag.environments.find(
                                (item) => item.environmentKey === environment.key,
                              )}
                              archived={Boolean(flag.archivedAt)}
                            />
                          </td>
                        ))}
                        <td className="px-4 py-3 align-top text-sm text-muted">
                          {flag.owner?.name ?? "Unassigned"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right align-top text-xs tabular-nums text-muted">
                          <time
                            dateTime={flag.updatedAt}
                            title={formatFlagDate(flag.updatedAt, true)}
                          >
                            {formatFlagDate(flag.updatedAt)}
                          </time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden">
                {data.items.map((flag) => (
                  <article
                    className="space-y-3 border-b border-border p-4 last:border-b-0"
                    key={flag.id}
                  >
                    <FlagIdentity flag={flag} />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      <Badge>{typeLabels[flag.type]}</Badge>
                      <span>{flag.owner?.name ?? "Unassigned"}</span>
                      <time dateTime={flag.updatedAt}>
                        Updated {formatFlagDate(flag.updatedAt)}
                      </time>
                    </div>
                    <dl className="space-y-3">
                      {environments.map((environment) => (
                        <div
                          className="flex items-center justify-between gap-4"
                          key={environment.key}
                        >
                          <dt className="min-w-0 break-words text-xs text-muted">
                            {environment.name}
                          </dt>
                          <dd className="w-40 shrink-0">
                            <EnvironmentStatus
                              environment={flag.environments.find(
                                (item) => item.environmentKey === environment.key,
                              )}
                              archived={Boolean(flag.archivedAt)}
                            />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2">
          <p className="text-xs text-muted">
            Percentages show configured rollout, including when a flag is off.
          </p>
          <label className="flex items-center gap-2 text-xs text-muted">
            Per page
            <select
              className="min-h-11 rounded-control border border-border bg-background px-2 text-sm text-foreground sm:min-h-8"
              value={query.pageSize}
              onChange={(event) => changeQuery({ pageSize: Number(event.target.value) })}
            >
              {Array.from(new Set([10, 25, 50, 100, initialData.pagination.pageSize]))
                .sort((a, b) => a - b)
                .map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <FlagPagination
          pagination={data.pagination}
          count={data.items.length}
          loading={loading}
          onPage={(page) => setQuery((previous) => ({ ...previous, page }))}
        />
      </section>

      {createOpen && canCreate ? (
        <CreateFlagDialog
          project={project}
          members={members}
          onClose={() => setCreateOpen(false)}
          onCreated={(flag) => {
            setCreateOpen(false);
            setCreated(flag);
            setQuery(listFlagsQuerySchema.parse({ pageSize: query.pageSize }));
            refresh();
          }}
        />
      ) : null}
      {created ? (
        <div
          className="fixed bottom-4 left-4 right-4 z-40 flex items-center gap-3 rounded-control border border-border bg-background px-4 py-3 text-sm shadow-popover sm:left-auto sm:max-w-md"
          role="status"
        >
          <Check size={16} className="shrink-0 text-success" aria-hidden="true" />
          <span className="min-w-0 break-words">
            Created {created.name}.{" "}
            <Link
              className="font-medium underline underline-offset-4"
              href={`/flags/${encodeURIComponent(created.id)}`}
            >
              View flag
            </Link>
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label="Dismiss notification"
            onClick={() => setCreated(null)}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
