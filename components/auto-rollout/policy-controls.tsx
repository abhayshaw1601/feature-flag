import { Button } from "@/components/ui/button";
import type { PolicyDraft, PolicyErrors } from "./monitor-format";

const inputClass =
  "num mt-2 min-h-11 w-full min-w-0 rounded-control border border-[var(--border-strong)] bg-background px-3 text-sm disabled:bg-surface disabled:text-muted";

export function PolicyControls({
  draft,
  errors,
  editable,
  optedIn,
  canStart,
  onDraft,
  onOptIn,
  onStart,
}: {
  draft: PolicyDraft;
  errors: PolicyErrors;
  editable: boolean;
  optedIn: boolean;
  canStart: boolean;
  onDraft: (draft: PolicyDraft) => void;
  onOptIn: (optedIn: boolean) => void;
  onStart: () => void;
}) {
  return (
    <section
      className="min-w-0 rounded-card border border-border p-4 sm:p-5"
      aria-labelledby="policy-title"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="policy-title" className="text-base font-medium">
          Ramp policy
        </h2>
        <p className="text-xs text-muted">
          {editable ? "Configure before starting." : "Reset the demo to edit this policy."}
        </p>
      </div>
      <form
        className="mt-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onStart();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label htmlFor="ramp-steps" className="block text-sm font-medium lg:min-h-10">
              Ramp steps (%)
            </label>
            <input
              id="ramp-steps"
              value={draft.steps}
              disabled={!editable}
              onChange={(event) => onDraft({ ...draft, steps: event.target.value })}
              aria-invalid={Boolean(errors.steps)}
              aria-describedby="ramp-steps-help"
              className={inputClass}
              autoComplete="off"
            />
            <p id="ramp-steps-help" className="mt-2 text-xs text-muted">
              {errors.steps ?? "Comma-separated, increasing, ending at 100%."}
            </p>
          </div>
          <div className="min-w-0">
            <label htmlFor="hold-seconds" className="block text-sm font-medium lg:min-h-10">
              Hold per step (seconds)
            </label>
            <input
              id="hold-seconds"
              type="number"
              inputMode="numeric"
              min={30}
              max={86400}
              step={1}
              value={draft.holdSeconds}
              disabled={!editable}
              onChange={(event) => onDraft({ ...draft, holdSeconds: event.target.value })}
              aria-invalid={Boolean(errors.holdSeconds)}
              aria-describedby="hold-seconds-help"
              className={inputClass}
            />
            <p id="hold-seconds-help" className="mt-2 text-xs text-muted">
              {errors.holdSeconds ?? "30–86,400 simulated seconds; checked every 30s."}
            </p>
          </div>
          <div className="min-w-0 sm:col-span-2 lg:col-span-1">
            <label htmlFor="error-threshold" className="block text-sm font-medium lg:min-h-10">
              Error guard (percentage points)
            </label>
            <input
              id="error-threshold"
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="any"
              value={draft.errorThreshold}
              disabled={!editable}
              onChange={(event) => onDraft({ ...draft, errorThreshold: event.target.value })}
              aria-invalid={Boolean(errors.errorThreshold)}
              aria-describedby="error-threshold-help"
              className={inputClass}
            />
            <p id="error-threshold-help" className="mt-2 text-xs text-muted">
              {errors.errorThreshold ?? "Absolute increase over baseline; 2 points means 1% to 3%."}
            </p>
          </div>
        </div>
        {errors.policy ? (
          <p role="alert" className="mt-3 text-sm">
            {errors.policy}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={optedIn}
              onChange={(event) => onOptIn(event.target.checked)}
              aria-describedby="opt-in-help"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            <span>
              <span className="font-medium">Opt in to automated rollout</span>
              <span id="opt-in-help" className="mt-1 block text-xs text-muted">
                Off by default. Opting out stops automation.
              </span>
            </span>
          </label>
          {editable ? (
            <div className="flex flex-wrap items-center gap-3">
              <span id="start-help" className="text-xs text-muted">
                {!optedIn
                  ? "Opt in to start."
                  : !canStart
                    ? "Fix the policy fields to start."
                    : "Start, then simulate traffic."}
              </span>
              <Button
                type="submit"
                variant="primary"
                className="min-h-11"
                disabled={!canStart}
                aria-describedby="start-help"
              >
                Start ramp
              </Button>
            </div>
          ) : null}
        </div>
      </form>
    </section>
  );
}
