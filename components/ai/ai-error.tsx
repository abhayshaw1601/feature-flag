"use client";

import { CircleAlert, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AiErrorProps = {
  message: string;
  onRetry: () => void;
  retryDisabled?: boolean;
  className?: string;
};

export function AiError({
  message,
  onRetry,
  retryDisabled = false,
  className,
}: Readonly<AiErrorProps>) {
  return (
    <div className={cn("rounded-card border border-border bg-surface p-5 sm:p-6", className)}>
      <div role="alert" aria-atomic="true">
        <h2 className="flex items-center gap-2 text-base font-medium">
          <CircleAlert size={17} className="shrink-0 text-danger" aria-hidden="true" />
          Could not generate a response
        </h2>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted">
          {message}
        </p>
      </div>
      <Button className="mt-4" onClick={onRetry} disabled={retryDisabled}>
        <RotateCcw size={15} aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}
