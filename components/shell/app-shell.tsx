import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";

type ShellContext = {
  workspace: { name: string };
  project: { name: string; key: string };
  user: { name: string; role: string };
};

export function AppShell({
  children,
  context,
}: Readonly<{ children: ReactNode; context: ShellContext }>) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <Sidebar context={context} />
        <div className="min-w-0 flex-1">
          <TopBar context={context} />
          <main id="main" className="min-w-0 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-[1200px]">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
