import Link from "next/link";
import { FlaskConical, Flag, GitBranch, Settings, Sparkles, ScrollText } from "lucide-react";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";

const navGroups = [
  {
    label: "Manage",
    items: [
      { label: "Flags", href: "/", icon: Flag, active: true },
      { label: "Experiments", href: "/experiments", icon: FlaskConical },
    ],
  },
  {
    label: "Observe",
    items: [
      { label: "Audit log", href: "/audit", icon: ScrollText },
      { label: "Assistant", href: "/assistant", icon: Sparkles },
    ],
  },
  {
    label: "Connect",
    items: [{ label: "Repositories", href: "/repositories", icon: GitBranch }],
  },
];

export function Sidebar({
  context,
}: Readonly<{
  context: { workspace: { name: string }; user: { name: string; role: string } };
}>) {
  return (
    <aside
      className="hidden w-[240px] shrink-0 flex-col border-r border-border px-4 py-5 xl:flex"
      aria-label="Primary"
    >
      <div className="flex items-center gap-2 px-2">
        <span
          className="grid h-8 w-8 place-items-center rounded-control bg-accent text-white"
          aria-hidden="true"
        >
          <Flag size={17} strokeWidth={1.8} />
        </span>
        <span className="text-[15px] font-medium tracking-[-0.01em]">FlagForge</span>
      </div>

      <div className="mt-8">
        <WorkspaceSwitcher workspaceName={context.workspace.name} />
      </div>

      <nav className="mt-8 flex-1 space-y-7">
        {navGroups.map((group) => (
          <div key={group.label}>
            <p className="mb-2 px-2 text-xs font-medium text-muted">{group.label}</p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.label}
                    className={`flex min-h-9 items-center gap-3 rounded-control px-2 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      item.active
                        ? "bg-surface font-medium text-foreground"
                        : "text-muted hover:bg-surface hover:text-foreground"
                    }`}
                    href={item.href}
                    aria-current={item.active ? "page" : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-border pt-4">
        <Link
          className="flex min-h-9 items-center gap-3 rounded-control px-2 text-sm text-muted transition-colors duration-150 hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          href="/settings"
        >
          <Settings size={17} strokeWidth={1.8} aria-hidden="true" />
          <span>Settings</span>
        </Link>
        <div className="mt-4 flex items-center gap-3 px-2 py-2">
          <span
            className="grid h-8 w-8 place-items-center rounded-full border border-border text-xs font-medium"
            aria-hidden="true"
          >
            PS
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{context.user.name}</p>
            <p className="truncate text-xs text-muted">{context.user.role}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
