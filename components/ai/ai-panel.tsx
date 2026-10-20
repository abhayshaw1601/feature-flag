import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type AiPanelProps = {
  model: string;
  mock: boolean;
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
  className?: string;
};

export function AiPanel({
  model,
  mock,
  children,
  title = "AI response",
  actions,
  className,
}: Readonly<AiPanelProps>) {
  return (
    <section
      aria-label={title}
      className={cn("min-w-0 rounded-card border border-accent bg-surface p-5 sm:p-6", className)}
    >
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-accent" aria-hidden="true" />
        <Badge>Generated</Badge>
      </div>
      <h2 className="mt-3 text-base font-medium">{title}</h2>
      <p className="mt-1 break-words text-xs leading-5 text-muted">
        Model: <span className="font-mono">{model}</span>
        {mock ? " · Mock mode — fixture response" : " · Live model response"}
      </p>
      <div className="mt-5 min-w-0">{children}</div>
      {actions ? <div className="mt-5 border-t border-border pt-4">{actions}</div> : null}
    </section>
  );
}
