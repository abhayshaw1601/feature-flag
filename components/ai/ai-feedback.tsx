"use client";

import { useId } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";

export type AiFeedbackValue = "up" | "down" | null;

export type AiFeedbackProps = {
  value: AiFeedbackValue;
  onChange: (value: AiFeedbackValue) => void;
  disabled?: boolean;
};

// Controlled local UI state; this component does not persist or transmit feedback.
export function AiFeedback({ value, onChange, disabled = false }: Readonly<AiFeedbackProps>) {
  const noteId = useId();

  return (
    <div role="group" aria-label="Response feedback" aria-describedby={noteId}>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={value === "up" ? "secondary" : "ghost"}
          className={value === "up" ? "text-accent" : undefined}
          aria-pressed={value === "up"}
          onClick={() => onChange(value === "up" ? null : "up")}
          disabled={disabled}
        >
          <ThumbsUp size={15} aria-hidden="true" />
          Helpful
        </Button>
        <Button
          size="sm"
          variant={value === "down" ? "secondary" : "ghost"}
          className={value === "down" ? "text-accent" : undefined}
          aria-pressed={value === "down"}
          onClick={() => onChange(value === "down" ? null : "down")}
          disabled={disabled}
        >
          <ThumbsDown size={15} aria-hidden="true" />
          Not helpful
        </Button>
      </div>
      <p id={noteId} className="mt-2 text-xs text-muted">
        Local feedback only. Not saved or sent.
      </p>
    </div>
  );
}
