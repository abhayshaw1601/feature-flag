"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const links = [
  ["Flags", "/"],
  ["Stale flags", "/stale-flags"],
  ["Experiments", "/experiments"],
  ["Audit log", "/audit"],
  ["Assistant", "/assistant"],
  ["Repositories", "/repositories"],
  ["Settings", "/settings"],
] as const;

export function MobileNavSheet() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        className="xl:hidden"
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <Menu size={19} aria-hidden="true" />
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-50 bg-background p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">FlagForge</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
            >
              <X size={19} aria-hidden="true" />
            </Button>
          </div>
          <nav className="mt-8 space-y-1" aria-label="Mobile navigation">
            {links.map(([label, href]) => (
              <Link
                key={href}
                className="flex min-h-11 items-center rounded-control px-3 text-base text-muted hover:bg-surface hover:text-foreground"
                href={href}
                onClick={() => setOpen(false)}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </>
  );
}
