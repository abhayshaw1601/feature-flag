import type { GuardrailResult, RolloutState } from "@/lib/auto-rollout/types";
import { formatDelta, formatMetric, formatVirtualTime, metricLabels } from "./monitor-format";

const statuses: Record<GuardrailResult["status"], { label: string; dot: string }> = {
  HEALTHY: { label: "Healthy", dot: "bg-success" },
  BREACHED: { label: "Breached", dot: "bg-danger" },
  INSUFFICIENT: { label: "Insufficient data", dot: "bg-warning" },
  INCONCLUSIVE: { label: "Inconclusive", dot: "bg-warning" },
};

export function GuardrailEvidence({ state }: { state: RolloutState }) {
  const latest = state.history.at(-1);
  const fresh = latest?.stepVersion === state.stepVersion;
  return (
    <section
      className="min-w-0 rounded-card border border-border p-4 sm:p-5"
      aria-labelledby="guardrail-title"
    >
      <h2 id="guardrail-title" className="text-base font-medium">
        Guardrail evidence
      </h2>
      <p className="mt-2 text-xs text-muted">
        {latest
          ? `Last evaluated at ${formatVirtualTime(latest.at)}, for the ${latest.rolloutPercent}% step.`
          : "Every guardrail must be healthy before an advance."}
        {latest && !fresh && state.status === "running"
          ? " The current step is waiting for fresh evidence."
          : ""}
      </p>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {state.policy.guardrails.map((guard) => {
          const result = latest?.checks.find((check) => check.metric === guard.metric);
          const status = result ? statuses[result.status] : null;
          return (
            <article key={guard.metric} className="min-w-0 border-t border-border pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{metricLabels[guard.metric]}</h3>
                <span className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${status?.dot ?? "bg-muted"}`}
                  />
                  {status?.label ?? "Not evaluated"}
                </span>
              </div>
              <dl className="num mt-2 grid grid-cols-3 gap-2 text-right text-xs">
                <div>
                  <dt className="text-muted">Baseline</dt>
                  <dd className="mt-1 text-sm">{formatMetric(guard.metric, result?.baseline)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Enabled</dt>
                  <dd className="mt-1 text-sm">{formatMetric(guard.metric, result?.enabled)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Deterioration</dt>
                  <dd className="mt-1 text-sm">{formatDelta(guard.metric, result?.delta)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted">
                Limit:{" "}
                {(guard.threshold * 100).toLocaleString("en-US", { maximumFractionDigits: 4 })}
                {guard.metric === "latency_ms"
                  ? "% relative increase"
                  : guard.metric === "conversion"
                    ? " pp decrease"
                    : " pp increase"}
                . {guard.windowSeconds}s window; {guard.minSamples.toLocaleString("en-US")} samples
                required per cohort.
              </p>
              <p className="mt-1 text-xs text-muted">
                Samples: baseline {result?.baselineSamples.toLocaleString("en-US") ?? "—"}, enabled{" "}
                {result?.enabledSamples.toLocaleString("en-US") ?? "—"}. z-score:{" "}
                {result?.zScore == null ? "—" : result.zScore.toFixed(2)}.
              </p>
              <p className="mt-2 break-words text-sm">
                {result?.reason ??
                  "Start the ramp and simulate traffic to evaluate this guardrail."}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
