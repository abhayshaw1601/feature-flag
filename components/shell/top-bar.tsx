import { ChevronDown, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandPalette } from "@/components/shell/command-palette";
import { EnvironmentSwitcher } from "@/components/shell/environment-switcher";
import { MobileNavSheet } from "@/components/shell/mobile-nav-sheet";
import { ThemeToggle } from "@/components/shell/theme-toggle";

export function TopBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex min-h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <MobileNavSheet />

        <button
          className="hidden min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:flex"
          type="button"
          aria-label="Current project: Checkout Platform"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">Checkout Platform</span>
            <span className="font-mono text-xs text-muted">checkout</span>
          </span>
          <ChevronDown size={15} className="shrink-0 text-muted" aria-hidden="true" />
        </button>

        <div className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
        <EnvironmentSwitcher />
        <div className="ml-auto flex items-center gap-1.5">
          <CommandPalette />
          <ThemeToggle />
          <Button className="hidden sm:inline-flex" variant="ghost" size="icon" aria-label="Open account menu">
            <UserRound size={18} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </header>
  );
}
