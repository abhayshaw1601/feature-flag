"use client";

import { Flag } from "lucide-react";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  rolloutRiskAssessmentSchema,
  snapshotAt,
  type RolloutRiskAssessment,
  type RolloutRiskInput,
  type TargetingSnapshot,
} from "@/lib/rollout-risk/types";
import { RolloutRiskDialog } from "./rollout-risk-dialog";
import { TargetingPreview } from "./targeting-preview";

const scenarios = [
  {
    id: "payments-ramp",
    label: "Payments · Production · 5% to 100%",
    flagKey: "checkout_v2",
    tags: ["payments"],
    environmentKey: "production",
    environmentLabel: "Production",
    before: 5,
    after: 100,
    description: "Expand payments from a small Production cohort to everyone.",
  },
  {
    id: "payments-launch",
    label: "Payments · Production · 0% to 100%",
    flagKey: "checkout_v2",
    tags: ["payments"],
    environmentKey: "production",
    environmentLabel: "Production",
    before: 0,
    after: 100,
    description: "Launch payments to all Production traffic without an initial cohort.",
  },
  {
    id: "development-ramp",
    label: "Dashboard · Development · 10% to 20%",
    flagKey: "dashboard_v2",
    tags: ["ui"],
    environmentKey: "development",
    environmentLabel: "Development",
    before: 10,
    after: 20,
    description: "Try a smaller rollout increase in Development.",
  },
];

async function loadDemoAssessment(
  input: RolloutRiskInput,
  signal: AbortSignal,
): Promise<RolloutRiskAssessment> {
  const response = await fetch("/api/ai/rollout-risk/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`The demo service returned HTTP ${response.status}. Please retry.`);
  }
  const payload: unknown = await response.json();
  const parsed = rolloutRiskAssessmentSchema.safeParse(
    payload && typeof payload === "object" && "data" in payload ? payload.data : null,
  );
  if (!parsed.success) {
    throw new Error("The demo service returned an invalid assessment. Please retry.");
  }
  return parsed.data;
}

export function RolloutRiskDemo() {
  const [scenarioId, setScenarioId] = useState(scenarios[0].id);
  const [current, setCurrent] = useState<TargetingSnapshot>(() => snapshotAt(scenarios[0].before));
  const [proposed, setProposed] = useState(String(scenarios[0].after));
  const [review, setReview] = useState<RolloutRiskInput | null>(null);
  const [toast, setToast] = useState<{ message: string } | null>(null);
  const scenario = scenarios.find((item) => item.id === scenarioId) ?? scenarios[0];
  const percentage = Number(proposed);
  const validPercentage =
    /^\d{1,3}$/.test(proposed) && Number.isInteger(percentage) && percentage <= 100;
  const after = validPercentage ? snapshotAt(percentage) : null;
  const unchanged = validPercentage && percentage === current.rolloutPercent;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function resetScenario(id: string) {
    const next = scenarios.find((item) => item.id === id) ?? scenarios[0];
    setScenarioId(next.id);
    setCurrent(snapshotAt(next.before));
    setProposed(String(next.after));
    setToast(null);
    setReview(null);
  }

  async function applyLocally(target: TargetingSnapshot) {
    setCurrent(structuredClone(target));
    setToast({
      message: `Demo rollout saved at ${target.rolloutPercent}%. Browser state only; no later steps scheduled.`,
    });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex items-center gap-2">
              <Flag size={18} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
              <span className="text-[15px] font-medium tracking-[-0.01em]">FlagForge</span>
            </div>
            <span className="text-sm text-muted">Demo workspace / Rollout risk</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1200px] space-y-6 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        <div>
          <h1 className="text-2xl font-medium tracking-[-0.02em]">Rollout risk demo</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            Review a proposed change, inspect its risk, and apply one rollout step locally.
          </p>
        </div>

        <div className="rounded-control border border-border bg-surface px-4 py-3 text-sm">
          <p className="font-medium">Fixture demo. No production persistence.</p>
          <p className="mt-1 text-muted">
            Assessments use a deterministic mock. No Gemini, database, or sign-in is required.
            Changes live only in this page and reset on reload.
          </p>
        </div>

        <section
          className="rounded-card border border-border"
          aria-labelledby="proposed-change-title"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 sm:px-5">
            <h2 id="proposed-change-title" className="text-base font-medium">
              Proposed targeting change
            </h2>
            <Button variant="quiet" className="min-h-11" onClick={() => resetScenario(scenarioId)}>
              Reset fixture
            </Button>
          </div>

          {/* Two equal columns plus a 24px gutter fill the inner width; stack below 768px. */}
          <div className="grid gap-6 p-4 sm:p-5 md:grid-cols-2">
            <form
              className="min-w-0 space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!after || unchanged) return;
                setReview({
                  flagKey: scenario.flagKey,
                  tags: [...scenario.tags],
                  environmentKey: scenario.environmentKey,
                  actorId: "demo-operator",
                  before: structuredClone(current),
                  after,
                  recentChanges: [],
                });
              }}
            >
              <div>
                <label htmlFor="rollout-scenario" className="block text-sm font-medium">
                  Scenario
                </label>
                <select
                  id="rollout-scenario"
                  className="mt-2 min-h-11 w-full min-w-0 rounded-control border border-[var(--border-strong)] bg-background px-3 text-sm"
                  value={scenarioId}
                  onChange={(event) => resetScenario(event.target.value)}
                  aria-describedby="scenario-description"
                >
                  {scenarios.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <p id="scenario-description" className="mt-2 text-sm text-muted">
                  {scenario.description}
                </p>
              </div>

              <div>
                <label htmlFor="proposed-percentage" className="block text-sm font-medium">
                  Proposed rollout (%)
                </label>
                <input
                  id="proposed-percentage"
                  name="proposed-percentage"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  required
                  value={proposed}
                  onChange={(event) => setProposed(event.target.value)}
                  aria-invalid={!validPercentage}
                  aria-describedby="percentage-help"
                  className="num mt-2 min-h-11 w-full rounded-control border border-[var(--border-strong)] bg-background px-3 text-sm"
                />
                <p id="percentage-help" className="mt-2 text-sm text-muted">
                  {!validPercentage
                    ? "Enter a whole number from 0 to 100."
                    : unchanged
                      ? "This matches the current percentage. Change it to review a new rollout."
                      : "Choose a whole number from 0 to 100. Review before applying."}
                </p>
              </div>

              <Button
                variant="primary"
                type="submit"
                className="min-h-11 w-full whitespace-normal aria-disabled:opacity-50 sm:w-auto"
                // Keep the trigger focusable when a save makes the draft unchanged.
                aria-disabled={!validPercentage || unchanged}
                aria-describedby="percentage-help"
                onClick={(event) => {
                  if (!validPercentage || unchanged) event.preventDefault();
                }}
              >
                Review rollout risk
              </Button>
            </form>

            <div className="min-w-0 space-y-4">
              <dl className="space-y-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-muted">Flag key</dt>
                  <dd className="break-all font-mono">{scenario.flagKey}</dd>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-muted">Fixture environment</dt>
                  <dd>{scenario.environmentLabel}</dd>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-muted">Tags</dt>
                  <dd>{scenario.tags.join(", ")}</dd>
                </div>
              </dl>
              <TargetingPreview before={current} after={after} afterLabel="Proposed after" />
              <p className="text-sm text-muted">
                The first safer step updates the current percentage only after confirmation. Holds
                and later steps are guidance; nothing runs on a schedule.
              </p>
              <p className="num text-sm" aria-live="polite" aria-atomic="true">
                Current demo rollout: <span className="font-medium">{current.rolloutPercent}%</span>
              </p>
            </div>
          </div>
        </section>
      </main>

      <div role="status" aria-live="polite" aria-atomic="true">
        {toast ? (
          <div className="fixed bottom-4 left-4 right-4 z-40 rounded-control border border-border bg-background px-4 py-3 text-sm shadow-popover sm:left-auto sm:max-w-md">
            {toast.message}
          </div>
        ) : null}
      </div>

      {review ? (
        <RolloutRiskDialog
          input={review}
          loadAssessment={loadDemoAssessment}
          onConfirm={applyLocally}
          onClose={() => setReview(null)}
          persistenceLabel="Demo: browser state only. No production persistence."
        />
      ) : null}
    </div>
  );
}
