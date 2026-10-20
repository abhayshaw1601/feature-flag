"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function WorkspaceSwitcher({ workspaceName }: Readonly<{ workspaceName: string }>) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        className="w-full justify-between px-2.5 text-left"
        variant="secondary"
        size="md"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0">
          <span className="block truncate text-xs text-muted">Workspace</span>
          <span className="block truncate text-sm">{workspaceName}</span>
        </span>
        <ChevronsUpDown size={15} aria-hidden="true" />
      </Button>
      {open ? (
        <div
          className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 rounded-card border border-border bg-surface p-1 shadow-popover"
          role="menu"
        >
          <button
            className="flex min-h-9 w-full items-center justify-between rounded-control px-2 text-left text-sm hover:bg-background"
            type="button"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Northstar Labs
            <Check size={15} aria-hidden="true" />
          </button>
          <button
            className="flex min-h-9 w-full items-center rounded-control px-2 text-left text-sm text-muted hover:bg-background"
            type="button"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Add workspace
          </button>
        </div>
      ) : null}
    </div>
  );
}
