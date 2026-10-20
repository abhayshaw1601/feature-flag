"use client";

import { Command, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { demoFlags } from "@/lib/seed-data";
import { Button } from "@/components/ui/button";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
    else setQuery("");
  }, [open]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return demoFlags.slice(0, 6);
    return demoFlags
      .filter((flag) => `${flag.name} ${flag.key}`.toLowerCase().includes(normalized))
      .slice(0, 8);
  }, [query]);

  return (
    <>
      <Button
        className="hidden min-w-[158px] justify-between gap-3 px-2.5 text-muted sm:inline-flex"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Search flags. Press Command K to open."
      >
        <span className="flex items-center gap-2">
          <Search size={15} aria-hidden="true" />
          <span>Search flags</span>
        </span>
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">
          ⌘K
        </kbd>
      </Button>
      <Button
        className="sm:hidden"
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Search flags"
      >
        <Search size={18} aria-hidden="true" />
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/30 px-4 pt-[12vh]"
          role="presentation"
        >
          <button
            className="absolute inset-0 cursor-default"
            type="button"
            aria-label="Close search"
            onClick={() => setOpen(false)}
          />
          <div
            className="relative w-full max-w-lg overflow-hidden rounded-card border border-border bg-surface shadow-popover"
            role="dialog"
            aria-modal="true"
            aria-label="Search flags"
          >
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search size={17} className="text-muted" aria-hidden="true" />
              <label className="sr-only" htmlFor="flag-search">
                Search flags by name or key
              </label>
              <input
                ref={inputRef}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
                id="flag-search"
                name="flag-search"
                type="search"
                autoComplete="off"
                placeholder="Search flags…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOpen(false);
                  if (event.key === "Enter" && results[0]) setOpen(false);
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close search"
                onClick={() => setOpen(false)}
              >
                <X size={17} aria-hidden="true" />
              </Button>
            </div>
            <div
              className="max-h-[360px] overflow-y-auto p-2"
              role="listbox"
              aria-label="Flag results"
            >
              {results.length ? (
                results.map((flag) => (
                  <button
                    key={flag.id}
                    className="flex min-h-12 w-full items-center justify-between rounded-control px-3 text-left hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    type="button"
                    onClick={() => setOpen(false)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{flag.name}</span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {flag.key}
                      </span>
                    </span>
                    <Command size={15} className="shrink-0 text-muted" aria-hidden="true" />
                  </button>
                ))
              ) : (
                <p className="px-3 py-8 text-center text-sm text-muted">
                  No flags match “{query}”.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted">
              <span className="font-mono">Esc</span>
              <span>to close</span>
              <span className="ml-auto">{demoFlags.length} seeded flags</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
