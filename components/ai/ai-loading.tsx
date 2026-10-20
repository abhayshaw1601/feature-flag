import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type AiLoadingProps = {
  progressText?: string;
  className?: string;
};

export function AiLoading({
  progressText = "Generating and validating a response…",
  className,
}: Readonly<AiLoadingProps>) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn("rounded-card border border-border bg-surface p-5 sm:p-6", className)}
    >
      <p className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle
          size={16}
          className="shrink-0 text-accent motion-safe:animate-spin"
          aria-hidden="true"
        />
        {progressText}
      </p>
      <div className="mt-5 space-y-3 motion-safe:animate-pulse" aria-hidden="true">
        <div className="skeleton block h-3 w-full" />
        <div className="skeleton block h-3 w-5/6" />
        <div className="skeleton block h-3 w-2/3" />
      </div>
    </div>
  );
}
