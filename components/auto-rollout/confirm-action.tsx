"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export type ConfirmAction = {
  kind: "advance" | "rollback";
  stepVersion: number;
  targetPercent: number;
};

export function ConfirmRolloutAction({
  action,
  flagKey,
  onConfirm,
  onClose,
}: {
  action: ConfirmAction;
  flagKey: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    cancel.current?.querySelector("button")?.focus();
    return () => {
      element?.close();
      if (previousFocus?.isConnected && !previousFocus.matches(":disabled")) {
        previousFocus.focus({ preventScroll: true });
      } else {
        document.getElementById("auto-rollout-main")?.focus({ preventScroll: true });
      }
    };
  }, []);

  const rollback = action.kind === "rollback";
  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-rollout-title"
      aria-describedby="confirm-rollout-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-card border border-border bg-background p-5 text-foreground shadow-popover backdrop:bg-black/40"
    >
      <h2 id="confirm-rollout-title" className="text-lg font-medium">
        {rollback ? "Roll back this demo flag?" : `Advance to ${action.targetPercent}%?`}
      </h2>
      <p id="confirm-rollout-description" className="mt-3 break-words text-sm">
        {rollback
          ? `Turn off ${flagKey}, set its demo rollout to 0%, and stop automation.`
          : `Advance ${flagKey} to the next step only if every guardrail is healthy. Safety and fresh-data requirements are checked again when you confirm.`}
      </p>
      <p className="mt-2 text-sm text-muted">
        Browser state only. No production flags are changed. Monitoring continues while this
        confirmation is open.
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <div ref={cancel}>
          <Button className="min-h-11" onClick={onClose}>
            Cancel
          </Button>
        </div>
        <Button variant="primary" className="min-h-11 whitespace-normal" onClick={onConfirm}>
          {rollback ? "Confirm rollback" : "Confirm advance"}
        </Button>
      </div>
    </dialog>
  );
}
