"use client";

import { Check, ChevronDown, Filter, RefreshCcw, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { FlagSummary, FlagType } from "@flagforge/contracts";
import { demoFlags, demoProjects, flagStatus } from "@/lib/seed-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const typeLabels: Record<FlagType, string> = {
  RELEASE: "Release",
  OPS: "Ops",
  EXPERIMENT: "Experiment",
  PERMISSION: "Permission",
};

const environments = [
  { key: "development", label: "Development" },
  { key: "staging", label: "Staging" },
  { key: "production", label: "Production" },
] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function EnvironmentStatus({ flag, environmentKey }: { flag: FlagSummary; environmentKey: string }) {
  const environment = flag.environments.find((item) => item.environmentKey === environmentKey);
  if (!environment) return <span className="text-muted">—</span>;

  const status = flagStatus(flag, environmentKey);
  const tone = status === "On" ? "text-success" : status === "Partial rollout" ? "text-warning" : "text-muted";
  return (
    <div className="min-w-[124px] space-y-2">
      <div className={`flex items-center gap-2 text-xs font-medium ${tone}`}>
        <span className="status-dot" aria-hidden="true" />
        <span>{status}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="rollout-track min-w-0 flex-1" aria-hidden="true">
          <div className="rollout-fill" style={{ width: `${environment.rolloutPercent}%` }} />
        </div>
        <span className="num w-8 text-right text-xs text-muted">{environment.rolloutPercent}%</span>
      </div>
    </div>
  );
}

function FlagIdentity({ flag }: { flag: FlagSummary }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-foreground">{flag.name}</p>
      <p className="mt-1 truncate font-mono text-xs text-muted">{flag.key}</p>
    </div>
  );
}

function MobileFlagRow({ flag }: { flag: FlagSummary }) {
  const production = flag.environments.find((item) => item.environmentKey === "production");
  return (
    <article className="flex items-center justify-between gap-4 border-b border-border px-4 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <FlagIdentity flag={flag} />
        <p className="mt-2 truncate text-xs text-muted">
          {typeLabels[flag.type]} · {flag.owner?.name ?? "Unassigned"} · updated {formatDate(flag.updatedAt)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs text-muted">Production</p>
        <p className="mt-1 flex items-center justify-end gap-2 text-xs font-medium">
          <span
            className={`status-dot ${production?.rolloutPercent === 100 ? "text-success" : production?.rolloutPercent ? "text-warning" : "text-muted"}`}
            aria-hidden="true"
          />
          {production?.rolloutPercent ?? 0}%
        </p>
      </div>
    </article>
  );
}

function FlagsSkeleton() {
  return (
    <div className="space-y-4 p-5" aria-label="Loading flags" aria-busy="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="grid grid-cols-4 gap-4" key={index}>
          <span className="skeleton h-4 w-40" />
          <span className="skeleton h-4 w-20" />
          <span className="skeleton h-4 w-24" />
          <span className="skeleton h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function EmptyFlags({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <Search size={24} className="text-muted" aria-hidden="true" />
      <p className="text-sm text-foreground">No flags match “{query}”.</p>
      <Button variant="secondary" size="sm" onClick={onClear}>Clear search</Button>
    </div>
  );
}

export function FlagsPage() {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<FlagType | "all">("all");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const visibleFlags = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return demoFlags.filter((flag) => {
      const matchesQuery = !normalized || `${flag.name} ${flag.key} ${flag.tags.join(" ")}`.toLowerCase().includes(normalized);
      const matchesType = typeFilter === "all" || flag.type === typeFilter;
      return matchesQuery && matchesType;
    });
  }, [query, typeFilter]);

  function refreshFlags() {
    setLoading(true);
    window.setTimeout(() => {
      setLoading(false);
      setToast("Flags loaded");
      window.setTimeout(() => setToast(null), 4000);
    }, 350);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h1 className="text-2xl font-medium tracking-[-0.02em]">Flags</h1>
          <p className="mt-2 text-sm text-muted">{demoFlags.length} flags across {demoProjects.length} projects.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={refreshFlags} disabled={loading}>
          <RefreshCcw size={15} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <section className="rounded-card border border-border bg-surface" aria-labelledby="flag-list-heading">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="flag-list-heading" className="text-base font-medium">Rollout overview</h2>
            <p className="mt-1 text-xs text-muted">Move from Development to Production with the rollout state in view.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[210px] flex-1 sm:flex-none">
              <span className="sr-only">Search flags</span>
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                className="h-9 w-full rounded-control border border-border-strong bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
                type="search"
                name="flag-filter"
                autoComplete="off"
                placeholder="Search flags…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="relative">
              <span className="sr-only">Filter by flag type</span>
              <SlidersHorizontal size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
              <select
                className="h-9 appearance-none rounded-control border border-border-strong bg-background pl-9 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
                name="flag-type"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value as FlagType | "all")}
              >
                <option value="all">All types</option>
                <option value="RELEASE">Release</option>
                <option value="OPS">Ops</option>
                <option value="EXPERIMENT">Experiment</option>
                <option value="PERMISSION">Permission</option>
              </select>
              <ChevronDown size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
            </label>
            <Button variant="ghost" size="icon" aria-label="Open flag filters">
              <Filter size={17} aria-hidden="true" />
            </Button>
          </div>
        </div>

        {loading ? <FlagsSkeleton /> : visibleFlags.length === 0 ? <EmptyFlags query={query} onClear={() => { setQuery(""); setTypeFilter("all"); }} /> : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[900px] border-collapse text-left">
                <caption className="sr-only">Feature flags and rollout state by environment</caption>
                <thead>
                  <tr className="border-b border-border text-xs font-medium text-muted">
                    <th className="w-[24%] px-4 py-3" scope="col">Flag</th>
                    <th className="px-4 py-3" scope="col">Type</th>
                    {environments.map((environment) => <th className="px-4 py-3" scope="col" key={environment.key}>{environment.label}</th>)}
                    <th className="px-4 py-3" scope="col">Owner</th>
                    <th className="px-4 py-3" scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFlags.map((flag) => (
                    <tr className="border-b border-border last:border-b-0" key={flag.id}>
                      <td className="px-4 py-4 align-top"><FlagIdentity flag={flag} /></td>
                      <td className="px-4 py-4 align-top"><Badge>{typeLabels[flag.type]}</Badge></td>
                      {environments.map((environment) => <td className="px-4 py-4 align-top" key={environment.key}><EnvironmentStatus flag={flag} environmentKey={environment.key} /></td>)}
                      <td className="px-4 py-4 align-top text-sm text-muted">{flag.owner?.name ?? "Unassigned"}</td>
                      <td className="num whitespace-nowrap px-4 py-4 align-top text-right text-xs text-muted">{formatDate(flag.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="md:hidden">
              {visibleFlags.map((flag) => <MobileFlagRow flag={flag} key={flag.id} />)}
            </div>
          </>
        )}
      </section>

      {toast ? (
        <div className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm shadow-popover" role="status" aria-live="polite">
          <Check size={16} className="text-success" aria-hidden="true" />
          {toast}
        </div>
      ) : null}
    </div>
  );
}
