import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <Sidebar />
        <div className="min-w-0 flex-1">
          <TopBar />
          <main id="main" className="min-w-0 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-[1200px]">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
