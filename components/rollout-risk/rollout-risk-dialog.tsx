"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { applyFirstStep } from "@/lib/rollout-risk/checks";
import type {
  RolloutRiskAssessment,
  RolloutRiskInput,
  TargetingSnapshot,
} from "@/lib/rollout-risk/types";
import { TargetingPreview } from "./targeting-preview";

export type RolloutRiskDialogProps = Readonly<{
  input: RolloutRiskInput;
  loadAssessment: (input: RolloutRiskInput, signal: AbortSignal) => Promise<RolloutRiskAssessment>;
  onConfirm: (target: TargetingSnapshot) => Promise<void>;
  onClose: () => void;
  /** Explicitly identify the save destination, e.g. "Demo: browser state only". */
  persistenceLabel: string;
}>;

type AssessmentState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: RolloutRiskAssessment; validUntil: number };

const riskDots = {
  LOW: "text-success",
  MEDIUM: "text-warning",
  HIGH: "text-danger",
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function AssessmentSource({ result }: { result: RolloutRiskAssessment }) {
  const label =
    result.source === "gemini"
      ? `Generated with ${result.model}`
      : result.source === "fallback"
        ? "Deterministic fallback; model generation unavailable"
        : "Deterministic mock; no model call";

  return (
    <div className="space-y-1 text-xs text-muted">
      <p className="break-words">{label}</p>
      <p>
        Assessed at{" "}
        <time dateTime={result.assessedAt}>
          {new Date(result.assessedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </time>
        {result.cached ? "; cached result" : ""}. Valid for at most 60 seconds.
      </p>
      {result.notice ? <p className="break-words">{result.notice}</p> : null}
    </div>
  );
}

/** Mount while open. A changed input starts a new, independently cancellable review. */
export function RolloutRiskDialog(props: RolloutRiskDialogProps) {
  return <RolloutRiskDialogSession key={JSON.stringify(props.input)} {...props} />;
}

function RolloutRiskDialogSession({
  input,
  loadAssessment,
  onConfirm,
  onClose,
  persistenceLabel,
}: RolloutRiskDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const loaderRef = useRef(loadAssessment);
  const mountedRef = useRef(false);
  const dismissedRef = useRef(false);
  const savingRef = useRef(false);
  // Keep the reviewed snapshot stable even if a caller mutates or recreates its draft.
  const [reviewInput] = useState(() => structuredClone(input));
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AssessmentState>({ status: "loading" });
  const [expired, setExpired] = useState(false);
  const [confirmationKey, setConfirmationKey] = useState("");
  const [saving, setSaving] = useState<"original" | "plan" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    loaderRef.current = loadAssessment;
  }, [loadAssessment]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    mountedRef.current = true;
    dismissedRef.current = false;
    dialog?.showModal();
    headingRef.current?.focus();

    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ status: "loading" });
    setExpired(false);
    setConfirmationKey("");
    setSaveError(null);

    async function assess() {
      try {
        const result = await loaderRef.current(structuredClone(reviewInput), controller.signal);
        // Some loaders cannot cancel their underlying work: also discard their late result.
        if (controller.signal.aborted || dismissedRef.current) return;
        const validUntil = Math.min(
          Date.parse(result.expiresAt),
          Date.parse(result.assessedAt) + 60_000,
          Date.now() + 60_000,
        );
        if (!Number.isFinite(validUntil)) {
          throw new Error("The assessment has no valid expiry. Retry to request a fresh result.");
        }
        setExpired(Date.now() >= validUntil);
        setState({ status: "ready", result, validUntil });
      } catch (error) {
        if (controller.signal.aborted || dismissedRef.current) return;
        setState({
          status: "error",
          message: errorMessage(error, "The assessment could not be loaded. Please retry."),
        });
      }
    }

    void assess();
    return () => controller.abort();
  }, [attempt, reviewInput]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const checkExpiry = () => {
      if (Date.now() >= state.validUntil) setExpired(true);
    };
    const timer = window.setTimeout(checkExpiry, Math.max(0, state.validUntil - Date.now()));
    window.addEventListener("focus", checkExpiry);
    document.addEventListener("visibilitychange", checkExpiry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", checkExpiry);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [state]);

  const assessment = state.status === "ready" ? state.result.assessment : null;
  const needsKey = assessment?.riskLevel === "HIGH";
  const keyMatches = !needsKey || confirmationKey === reviewInput.flagKey;
  const canSave = state.status === "ready" && !expired && !saving && keyMatches;
  const firstStep = assessment?.saferPlan[0];

  function close() {
    if (savingRef.current || dismissedRef.current) return;
    dismissedRef.current = true;
    requestRef.current?.abort();
    dialogRef.current?.close();
    onClose();
  }

  function retry() {
    if (savingRef.current || dismissedRef.current) return;
    requestRef.current?.abort();
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  async function confirm(choice: "original" | "plan") {
    if (
      state.status !== "ready" ||
      savingRef.current ||
      dismissedRef.current ||
      expired ||
      !keyMatches
    ) {
      return;
    }
    // Check the clock again at the click boundary, including after a background-tab pause.
    if (Date.now() >= state.validUntil) {
      setExpired(true);
      return;
    }
    if (choice === "plan" && !firstStep) return;
    savingRef.current = true;
    setSaving(choice);
    setSaveError(null);
    try {
      const target =
        choice === "plan" && firstStep
          ? applyFirstStep(reviewInput, state.result.assessment)
          : structuredClone(reviewInput.after);
      await onConfirm(target);
      if (!mountedRef.current) return;
      savingRef.current = false;
      close();
    } catch (error) {
      if (!mountedRef.current) return;
      setSaveError(errorMessage(error, "The change could not be saved. Please try again."));
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-scope`}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto overscroll-contain rounded-card border border-border bg-background p-0 text-foreground shadow-popover backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        // Ignore the queued close event from React Strict Mode's setup/cleanup cycle.
        if (!dialogRef.current?.open) close();
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border p-4 sm:p-6">
        <div className="min-w-0">
          <h2
            id={`${id}-title`}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-medium outline-none"
          >
            Review rollout change
          </h2>
          <p id={`${id}-scope`} className="mt-1 text-sm text-muted">
            {persistenceLabel}
          </p>
        </div>
        <Button variant="ghost" className="min-h-11 shrink-0" onClick={close} disabled={!!saving}>
          Cancel
        </Button>
      </div>

      <div className="space-y-5 p-4 sm:p-6">
        <div>
          <p className="break-all font-mono text-sm">{reviewInput.flagKey}</p>
          <p className="mt-1 break-words text-sm text-muted">
            Environment: {reviewInput.environmentKey}
          </p>
        </div>
        <TargetingPreview before={reviewInput.before} after={reviewInput.after} />

        <section aria-labelledby={`${id}-assessment`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${id}-assessment`} className="text-base font-medium">
              Risk assessment
            </h3>
            {assessment ? (
              <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border px-2.5 py-1 text-xs font-medium">
                <span
                  className={`status-dot ${riskDots[assessment.riskLevel]}`}
                  aria-hidden="true"
                />
                {assessment.riskLevel} risk
              </span>
            ) : null}
          </div>

          {state.status === "loading" ? (
            <div className="mt-3">
              <p role="status" className="text-sm text-muted">
                Checking this change. You can cancel while the assessment loads.
              </p>
              <div className="mt-4 space-y-3" aria-hidden="true" aria-busy="true">
                <span className="skeleton block h-4 w-3/4" />
                <span className="skeleton block h-4 w-full" />
                <span className="skeleton block h-4 w-5/6" />
              </div>
            </div>
          ) : state.status === "error" ? (
            <div className="mt-3 rounded-control border border-border p-4">
              <p role="alert" className="break-words text-sm">
                Could not load the assessment. {state.message}
              </p>
              <Button className="mt-3 min-h-11" onClick={retry}>
                Retry assessment
              </Button>
            </div>
          ) : assessment ? (
            <div className="mt-3 space-y-4">
              <p role="status" className="sr-only">
                Assessment loaded: {assessment.riskLevel} risk.
              </p>
              {assessment.reasons.length ? (
                <ul className="list-disc space-y-2 pl-5 text-sm">
                  {assessment.reasons.map((reason, index) => (
                    <li className="break-words" key={index}>
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No risk reasons were reported.</p>
              )}
              <AssessmentSource result={state.result} />
            </div>
          ) : null}
        </section>

        {expired ? (
          <div className="rounded-control border border-border bg-surface p-4">
            <p role="alert" className="text-sm">
              This assessment has expired. Retry before saving a change.
            </p>
            <Button className="mt-3 min-h-11" onClick={retry} disabled={!!saving}>
              Retry assessment
            </Button>
          </div>
        ) : null}

        {assessment ? (
          <>
            <section aria-labelledby={`${id}-safeguards`}>
              <h3 id={`${id}-safeguards`} className="text-sm font-medium">
                Missing safeguards
              </h3>
              {assessment.missingSafeguards.length ? (
                <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
                  {assessment.missingSafeguards.map((safeguard, index) => (
                    <li className="break-words" key={index}>
                      {safeguard}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted">No missing safeguards were reported.</p>
              )}
            </section>

            {needsKey ? (
              <div>
                <label htmlFor={`${id}-key`} className="block text-sm font-medium">
                  Type the flag key to confirm
                </label>
                <p id={`${id}-key-help`} className="mt-1 text-sm text-muted">
                  The original change is HIGH risk. Both actions require an exact match for{" "}
                  <code className="break-all font-mono text-foreground">{reviewInput.flagKey}</code>
                  .
                </p>
                <input
                  id={`${id}-key`}
                  className="mt-3 min-h-11 w-full rounded-control border border-[var(--border-strong)] bg-background px-3 font-mono text-sm"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby={`${id}-key-help`}
                  value={confirmationKey}
                  onChange={(event) => setConfirmationKey(event.target.value)}
                  disabled={!!saving || expired}
                />
              </div>
            ) : null}

            <details className="rounded-control border border-border">
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                Safer rollout plan ({assessment.saferPlan.length}{" "}
                {assessment.saferPlan.length === 1 ? "step" : "steps"})
              </summary>
              <div className="space-y-4 border-t border-border p-4">
                {firstStep ? (
                  <>
                    <ol className="space-y-4">
                      {assessment.saferPlan.map((step, index) => (
                        <li className="space-y-1 text-sm" key={`${step.step}-${index}`}>
                          <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 font-medium">
                            <span className="num">
                              Step {step.step}: {step.rolloutPercent}%
                            </span>
                            <span className="text-xs font-normal text-muted">
                              {index === 0 ? "Applied on confirmation" : "Manual follow-up"}
                            </span>
                          </p>
                          <p className="break-words text-muted">Hold: {step.hold}</p>
                          <p className="break-words text-muted">Watch: {step.watch}</p>
                        </li>
                      ))}
                    </ol>
                    <p className="text-sm text-muted">
                      Saves the first step only, capping default and rule percentages at{" "}
                      <span className="num text-foreground">{firstStep.rolloutPercent}%</span>.
                      Later steps are not scheduled automatically.
                    </p>
                    <Button
                      variant="primary"
                      className="min-h-11 w-full whitespace-normal sm:w-auto"
                      disabled={!canSave}
                      onClick={() => void confirm("plan")}
                    >
                      {saving === "plan" ? "Saving first step…" : "Use this plan"}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted">No alternative rollout steps were returned.</p>
                )}
              </div>
            </details>
          </>
        ) : null}

        {saveError ? (
          <p role="alert" className="break-words rounded-control border border-border p-4 text-sm">
            Could not save the change. {saveError} Review the result and try again.
          </p>
        ) : null}
        {saving ? (
          <p role="status" className="text-sm text-muted">
            Saving the {saving === "plan" ? "first step" : "original change"}. Keep this dialog open
            until the save finishes.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-xs text-muted">
          Original request: <span className="num">{reviewInput.after.rolloutPercent}%</span> default
          rollout.
        </p>
        <Button
          variant="secondary"
          className="min-h-11 whitespace-normal"
          disabled={!canSave}
          onClick={() => void confirm("original")}
        >
          {saving === "original" ? "Saving original change…" : "Confirm original change"}
        </Button>
      </div>
    </dialog>
  );
}
