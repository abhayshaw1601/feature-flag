"use client";

import { Flag } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  advanceNow,
  createDemoRollout,
  pauseRollout,
  resumeRollout,
  rollBackNow,
  setOptIn,
  simulateCycle,
  startRollout,
} from "@/lib/auto-rollout/simulator";
import type { RolloutState } from "@/lib/auto-rollout/types";
import { ConfirmRolloutAction, type ConfirmAction } from "./confirm-action";
import { GuardrailEvidence } from "./guardrail-evidence";
import { MetricsChart } from "./metrics-chart";
import { createPolicyDraft, formatVirtualTime, validatePolicyDraft } from "./monitor-format";
import { PolicyControls } from "./policy-controls";
import { RolloutActivity } from "./rollout-activity";

type MonitorSession = {
  rollout: RolloutState;
  traffic: boolean;
  injectErrors: boolean;
  error: string | null;
  confirmation: ConfirmAction | null;
  clockVersion: number;
};

const statusLabels: Record<RolloutState["status"], string> = {
  idle: "Not started",
  running: "Monitoring",
  paused: "Automation paused",
  rolled_back: "Rolled back",
  completed: "Ramp complete",
};

function createSession(clockVersion = 0): MonitorSession {
  return {
    rollout: createDemoRollout(),
    traffic: false,
    injectErrors: false,
    error: null,
    confirmation: null,
    clockVersion,
  };
}

function actionError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "This action could not be applied. Review the rollout state and try again.";
}

function DecisionSummary({ state }: { state: RolloutState }) {
  const latest = state.history.at(-1);
  const currentEvidence = latest?.stepVersion === state.stepVersion;
  let summary: string;
  switch (state.status) {
    case "idle":
      summary = "Automation is off. Review the policy and opt in to start a synthetic rollout.";
      break;
    case "paused":
      summary =
        "Automation is paused; the demo flag keeps its current setting. Resume starts a fresh hold and evidence window.";
      break;
    case "rolled_back":
      summary = "The demo flag is off. The rollout is at 0% and automation has stopped.";
      break;
    case "completed":
      summary =
        "The final healthy hold is complete. The demo flag stays on at 100%; automation has stopped.";
      break;
    default:
      summary =
        !latest || !currentEvidence
          ? "Collecting fresh evidence for this step. Automation will hold until every guardrail is healthy and the hold has elapsed."
          : latest.decision === "HOLD"
            ? "Holding the current step. The latest check has not approved an advance."
            : latest.decision === "ADVANCE"
              ? "The latest check approved an advance."
              : "The latest check requested a rollback.";
  }
  return (
    <div className="mt-4 rounded-control bg-surface p-3 text-sm">
      <p role="status" aria-live="polite" aria-atomic="true" className="font-medium">
        {summary}
      </p>
      {latest?.reasons[0] ? <p className="mt-2 break-words">{latest.reasons[0]}</p> : null}
      {latest ? (
        <details className="mt-2" open={state.status === "rolled_back"}>
          <summary className="cursor-pointer rounded-control py-1 text-xs text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            Last monitoring decision at {formatVirtualTime(latest.at)} for {latest.rolloutPercent}%
          </summary>
          <ul className="mt-2 list-disc space-y-1 break-words pl-4 text-sm">
            {latest.reasons.map((reason, index) => (
              <li key={`${index}-${reason}`}>{reason}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Deterministic policy explanation. No live AI or model calls.
          </p>
        </details>
      ) : (
        <p className="mt-1 text-xs text-muted">
          Decision explanations come from deterministic engine rules, not live AI.
        </p>
      )}
    </div>
  );
}

export function AutoRolloutMonitor() {
  const [session, setSession] = useState<MonitorSession>(() => createSession());
  const [draft, setDraft] = useState(createPolicyDraft);
  const interval = useRef<number | null>(null);
  const { rollout: state } = session;
  const { policy, errors } = validatePolicyDraft(draft);
  const editable = state.status === "idle";
  const running = state.status === "running" && state.optedIn;
  const finished = state.status === "completed" || state.status === "rolled_back";
  const active = state.status === "running" || state.status === "paused";
  const displayedPolicy = editable && policy ? policy : state.policy;
  const nextPercent = state.policy.steps[state.stepIndex + 1];
  const canAdvance = active && state.optedIn && nextPercent !== undefined;
  const lastCheck = state.history.at(-1);

  useEffect(() => {
    if (state.status !== "running" || !state.optedIn) return;
    let cancelled = false;
    const version = session.clockVersion;
    const timer = window.setInterval(() => {
      if (cancelled) return;
      setSession((previous) => {
        // Read traffic settings from the same update as the engine state. An old timer
        // cannot tick a reset or resumed session, even if its callback was queued.
        if (
          cancelled ||
          previous.clockVersion !== version ||
          previous.rollout.status !== "running" ||
          !previous.rollout.optedIn
        )
          return previous;
        try {
          const rollout = simulateCycle(previous.rollout, {
            traffic: previous.traffic,
            injectErrors: previous.injectErrors,
          });
          return {
            ...previous,
            rollout,
            traffic:
              rollout.status === "completed" || rollout.status === "rolled_back"
                ? false
                : previous.traffic,
          };
        } catch (error) {
          // Error and rollout are one state value: no nested setState in an updater.
          return {
            ...previous,
            rollout: pauseRollout(previous.rollout),
            clockVersion: previous.clockVersion + 1,
            error: `Monitoring stopped: ${actionError(error)}`,
          };
        }
      });
    }, 1000);
    interval.current = timer;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (interval.current === timer) interval.current = null;
    };
  }, [state.status, state.optedIn, session.clockVersion]);

  function applyAction(operation: (rollout: RolloutState) => RolloutState) {
    setSession((previous) => {
      try {
        const rollout = operation(previous.rollout);
        return {
          ...previous,
          rollout,
          traffic:
            rollout.status === "completed" || rollout.status === "rolled_back"
              ? false
              : previous.traffic,
          error: null,
          confirmation: null,
          clockVersion: previous.clockVersion + 1,
        };
      } catch (error) {
        return { ...previous, confirmation: null, error: actionError(error) };
      }
    });
  }

  function start() {
    if (!policy) {
      setSession((previous) => ({
        ...previous,
        error: "Correct the invalid policy fields before starting the ramp.",
      }));
      return;
    }
    applyAction((rollout) => {
      if (rollout.status !== "idle")
        throw new Error("Reset the demo before starting a new policy.");
      return startRollout({ ...rollout, policy });
    });
  }

  function reset() {
    if (interval.current !== null) window.clearInterval(interval.current);
    interval.current = null;
    setSession((previous) => createSession(previous.clockVersion + 1));
    setDraft(createPolicyDraft());
  }

  function askToConfirm(kind: ConfirmAction["kind"]) {
    setSession((previous) => ({
      ...previous,
      error: null,
      confirmation: {
        kind,
        stepVersion: previous.rollout.stepVersion,
        targetPercent:
          kind === "rollback" ? 0 : previous.rollout.policy.steps[previous.rollout.stepIndex + 1],
      },
    }));
  }

  function confirm() {
    const confirmation = session.confirmation;
    if (!confirmation) return;
    applyAction((rollout) => {
      if (confirmation.kind === "rollback") return rollBackNow(rollout);
      if (rollout.stepVersion !== confirmation.stepVersion) {
        throw new Error(
          "The rollout changed while confirmation was open. Review the current step and choose Advance now again.",
        );
      }
      return advanceNow(rollout);
    });
  }

  const holdElapsed =
    state.stepStartedAt === null
      ? 0
      : Math.max(0, Math.floor((state.now - state.stepStartedAt) / 1000));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#auto-rollout-main">
        Skip to main content
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1280px] items-start justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex items-center gap-2">
              <Flag size={18} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
              <span className="text-[15px] font-medium tracking-[-0.01em]">FlagForge</span>
            </div>
            <span className="text-sm text-muted">Demo workspace / Auto-rollout</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main
        id="auto-rollout-main"
        tabIndex={-1}
        className="mx-auto max-w-[1280px] space-y-4 px-4 pb-10 pt-6 sm:px-6 lg:px-8"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-medium tracking-[-0.02em]">Auto-rollout monitor</h1>
            <p className="mt-1 break-words text-sm text-muted">
              Watch a synthetic rollout advance, hold, or roll back on guardrail evidence.
            </p>
          </div>
          <Button variant="quiet" className="min-h-11" onClick={reset}>
            Reset demo
          </Button>
        </div>

        <aside
          className="rounded-control border border-border bg-surface px-4 py-3 text-sm"
          aria-label="Simulation scope"
        >
          <p className="font-medium">Browser-only simulation. No production flags are changed.</p>
          <p className="mt-1 text-muted">
            Synthetic metrics, audit events, and notifications. No sign-in, database, API calls, or
            live AI. Accelerated time:{" "}
            <span className="text-foreground">1 wall second = 30 simulated seconds.</span>
          </p>
        </aside>

        {/* The live status and its chart stay together; setup and overrides share the right column. */}
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <section
              className="min-w-0 rounded-card border border-border p-4 sm:p-5"
              aria-labelledby="rollout-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 id="rollout-title" className="break-all text-base font-medium">
                    {state.flagKey}
                  </h2>
                  <p className="mt-1 break-all text-xs text-muted">
                    Synthetic environment: {state.environmentId}
                  </p>
                  <p className="mt-2 flex items-center gap-2 text-sm">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-full ${running ? "bg-accent" : state.status === "rolled_back" ? "bg-danger" : "bg-muted"}`}
                    />
                    {statusLabels[state.status]}
                  </p>
                </div>
                <dl className="num flex flex-wrap gap-x-8 gap-y-3">
                  <div>
                    <dt className="text-xs text-muted">Demo flag</dt>
                    <dd className="mt-1 text-2xl font-medium">
                      {state.enabled ? "On" : "Off"}
                      <span className="ml-2 text-sm font-normal text-muted">
                        at {state.rolloutPercent}%
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Simulated clock</dt>
                    <dd className="mt-2 text-sm">{formatVirtualTime(state.now)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Next decision</dt>
                    <dd className="mt-2 text-sm">
                      {running && state.nextCheckAt !== null
                        ? `${formatVirtualTime(state.nextCheckAt)} (in ${Math.max(0, (state.nextCheckAt - state.now) / 1000)}s)`
                        : "Not scheduled"}
                    </dd>
                  </div>
                </dl>
              </div>
              <ol
                className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-[repeat(var(--ramp-columns),minmax(0,1fr))]"
                style={
                  { "--ramp-columns": Math.min(displayedPolicy.steps.length, 5) } as CSSProperties
                }
                aria-label="Rollout ramp steps"
              >
                {displayedPolicy.steps.map((percent, index) => {
                  const current = !editable && state.enabled && index === state.stepIndex;
                  const passed =
                    !editable &&
                    state.enabled &&
                    (index < state.stepIndex || state.status === "completed");
                  return (
                    <li
                      key={percent}
                      aria-current={current ? "step" : undefined}
                      className={`min-w-0 rounded-control border px-2 py-2 text-center ${current ? "border-accent bg-[var(--accent-soft)]" : "border-border bg-surface"}`}
                    >
                      <span className="num text-sm font-medium">{percent}%</span>
                      <span className="mt-1 block text-[11px] text-muted">
                        {state.status === "rolled_back"
                          ? "Stopped"
                          : state.status === "completed" || passed
                            ? "Done"
                            : current
                              ? "Current"
                              : "Planned"}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p className="num mt-2 text-xs text-muted">
                {active
                  ? `${Math.min(holdElapsed, state.policy.holdSeconds)} / ${state.policy.holdSeconds}s hold elapsed.`
                  : `${displayedPolicy.holdSeconds}s hold per step.`}{" "}
                A completed hold still requires healthy evidence.
              </p>
              <DecisionSummary state={state} />
            </section>
            <MetricsChart history={state.history} running={running} />
          </div>

          <div className="min-w-0 space-y-4">
            <PolicyControls
              draft={draft}
              errors={errors}
              editable={editable}
              optedIn={state.optedIn}
              canStart={editable && state.optedIn && policy !== null}
              onDraft={setDraft}
              onOptIn={(optedIn) => applyAction((rollout) => setOptIn(rollout, optedIn))}
              onStart={start}
            />

            <section
              className="min-w-0 rounded-card border border-border p-4 sm:p-5"
              aria-labelledby="controls-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 id="controls-title" className="text-base font-medium">
                    Simulation controls
                  </h2>
                  <p className="mt-1 text-xs text-muted">
                    {running
                      ? "Monitoring ticks every wall second, even when traffic is stopped."
                      : "The clock and traffic advance only while automation is running."}
                  </p>
                </div>
                <p className="text-xs text-muted">
                  {lastCheck
                    ? `Last check: ${formatVirtualTime(lastCheck.at)}`
                    : running
                      ? "Waiting for first check…"
                      : "No checks yet"}
                </p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
                <Button
                  className="min-h-11"
                  aria-pressed={session.traffic}
                  disabled={finished}
                  onClick={() =>
                    setSession((previous) => ({ ...previous, traffic: !previous.traffic }))
                  }
                >
                  {session.traffic ? "Stop traffic" : "Simulate traffic"}
                </Button>
                <label
                  className={`flex min-h-11 items-center gap-2 text-sm ${finished ? "text-muted" : "cursor-pointer"}`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent)]"
                    checked={session.injectErrors}
                    disabled={finished}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSession((previous) => ({ ...previous, injectErrors: checked }));
                    }}
                    aria-describedby="inject-help"
                  />
                  Inject errors
                </label>
                <span id="inject-help" className="text-xs text-muted">
                  Only the enabled variation degrades.
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {state.status === "running" ? (
                  <Button className="min-h-11" onClick={() => applyAction(pauseRollout)}>
                    Pause automation
                  </Button>
                ) : state.status === "paused" ? (
                  <Button
                    className="min-h-11"
                    disabled={!state.optedIn}
                    onClick={() => applyAction(resumeRollout)}
                  >
                    Resume
                  </Button>
                ) : null}
                <Button
                  className="min-h-11"
                  disabled={!canAdvance}
                  onClick={() => askToConfirm("advance")}
                  aria-describedby="manual-help"
                >
                  Advance now
                </Button>
                <Button
                  className="min-h-11"
                  disabled={!state.enabled}
                  onClick={() => askToConfirm("rollback")}
                >
                  Roll back now
                </Button>
              </div>
              <p id="manual-help" className="mt-3 text-xs text-muted">
                {!state.optedIn && active ? "Opt back in before resuming or advancing. " : ""}
                {finished ? "Reset to try another ramp. " : ""}
                {active && nextPercent === undefined
                  ? "This is the final step; no further manual advance is available. "
                  : ""}
                Manual advance requires every guardrail to be healthy; it cannot bypass missing or
                unsafe data. Resume starts a fresh hold.
              </p>
              {session.error ? (
                <div role="alert" className="mt-3 rounded-control border border-danger p-3 text-sm">
                  <p className="font-medium">Action could not complete</p>
                  <p className="mt-1 break-words">{session.error}</p>
                </div>
              ) : null}
            </section>
          </div>
        </div>

        <GuardrailEvidence state={{ ...state, policy: displayedPolicy }} />
        <RolloutActivity state={state} />
      </main>
      {session.confirmation ? (
        <ConfirmRolloutAction
          action={session.confirmation}
          flagKey={state.flagKey}
          onConfirm={confirm}
          onClose={() => setSession((previous) => ({ ...previous, confirmation: null }))}
        />
      ) : null}
    </div>
  );
}
