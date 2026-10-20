"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { MetricName, MonitorRecord } from "@/lib/auto-rollout/types";
import { formatMetric, formatVirtualTime, metricLabels } from "./monitor-format";

const series = [
  { key: "enabled", label: "Enabled", color: "var(--accent)", dash: undefined },
  { key: "baseline", label: "Baseline", color: "var(--text-tertiary)", dash: "5 4" },
] as const;

function displayValue(metric: MetricName, value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return metric === "latency_ms" ? value : value * 100;
}

function tickSize(maximum: number) {
  if (maximum <= 0) return 1;
  const rough = (maximum * 1.1) / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  return ([1, 2, 5, 10].find((step) => step * magnitude >= rough) ?? 10) * magnitude;
}

export function MetricsChart({ history, running }: { history: MonitorRecord[]; running: boolean }) {
  const [metric, setMetric] = useState<MetricName>("error_rate");
  const [width, setWidth] = useState(640);
  const container = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const records = history.slice(-60);
  const points = records.map((record) => {
    const check = record.checks.find((item) => item.metric === metric);
    return {
      record,
      check,
      baseline: displayValue(metric, check?.baseline),
      enabled: displayValue(metric, check?.enabled),
    };
  });
  const values = points
    .flatMap((point) => [point.baseline, point.enabled])
    .filter((value) => value !== null);
  const hasValues = values.length > 0;
  const yStep = tickSize(Math.max(0, ...values));
  const yMax = yStep * 3;
  const firstTime = points[0]?.record.at ?? 0;
  const lastTime = points.at(-1)?.record.at ?? firstTime;
  const timeStep = Math.max(30_000, Math.ceil((lastTime - firstTime) / 3 / 30_000) * 30_000);
  const left = metric === "latency_ms" ? 56 : 48;
  const right = width - 16;
  const top = 16;
  const bottom = 160;
  const x = (time: number) => left + ((time - firstTime) / (timeStep * 3)) * (right - left);
  const y = (value: number) => bottom - (value / yMax) * (bottom - top);
  const latest = points.at(-1);
  const unit = metric === "latency_ms" ? "ms" : "%";

  return (
    <section
      className="min-w-0 rounded-card border border-border p-4 sm:p-5"
      aria-labelledby="metrics-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="metrics-title" className="text-base font-medium">
          Cohort metrics
        </h2>
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor="plotted-metric" className="sr-only">
            Plotted metric
          </label>
          <select
            id="plotted-metric"
            value={metric}
            onChange={(event) => setMetric(event.target.value as MetricName)}
            className="min-h-11 max-w-full rounded-control border border-[var(--border-strong)] bg-background px-3 text-sm"
          >
            {Object.entries(metricLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {metricLabels[metric]} ({unit})
        </span>
        <ul className="flex flex-wrap gap-4" aria-label="Chart legend">
          {series.map((item) => (
            <li key={item.key} className="flex items-center gap-2">
              <svg width="22" height="10" aria-hidden="true">
                <line
                  x1="0"
                  y1="5"
                  x2="22"
                  y2="5"
                  stroke={item.color}
                  strokeWidth="2"
                  strokeDasharray={item.dash}
                />
              </svg>
              {item.label}
            </li>
          ))}
        </ul>
      </div>
      <div ref={container} className="mt-2 min-w-0">
        <svg
          viewBox={`0 0 ${width} 212`}
          width="100%"
          height="212"
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
        >
          <title
            id={titleId}
          >{`${metricLabels[metric]}: baseline and enabled synthetic cohorts`}</title>
          <desc id={descriptionId}>
            {hasValues
              ? "Measured values from the latest 60 monitoring checks, with gaps for missing evidence. Exact values are in the table below."
              : "No measured values yet. Start the ramp and simulate traffic to collect evidence."}
          </desc>
          {[0, 1, 2, 3].map((index) => (
            <g key={index}>
              <line
                x1={left}
                x2={right}
                y1={y(index * yStep)}
                y2={y(index * yStep)}
                stroke="var(--border)"
              />
              <text
                x={left - 8}
                y={y(index * yStep) + 4}
                textAnchor="end"
                fontSize="11"
                fill="var(--text-secondary)"
              >
                {hasValues || index === 0 ? Number((index * yStep).toFixed(2)) : ""}
              </text>
              <text
                x={x(firstTime + index * timeStep)}
                y="183"
                textAnchor={index === 0 ? "start" : index === 3 ? "end" : "middle"}
                fontSize="11"
                fill="var(--text-secondary)"
              >
                {(firstTime + index * timeStep) / 1000}
              </text>
            </g>
          ))}
          {series.map((item) => {
            let connected = false;
            const path = points
              .map((point) => {
                const value = point[item.key];
                if (value === null) {
                  connected = false;
                  return "";
                }
                const command = `${connected ? "L" : "M"}${x(point.record.at)},${y(value)}`;
                connected = true;
                return command;
              })
              .join(" ");
            return (
              <g key={item.key} fill="none" stroke={item.color} strokeWidth="2">
                <path d={path} strokeDasharray={item.dash} />
                {points.map((point, index) => {
                  const value = point[item.key];
                  if (
                    value === null ||
                    points[index - 1]?.[item.key] != null ||
                    points[index + 1]?.[item.key] != null
                  )
                    return null;
                  return (
                    <circle
                      key={`${point.record.at}-${index}`}
                      cx={x(point.record.at)}
                      cy={y(value)}
                      r="3"
                    />
                  );
                })}
              </g>
            );
          })}
          <text
            x={(left + right) / 2}
            y="205"
            textAnchor="middle"
            fontSize="11"
            fill="var(--text-secondary)"
          >
            Elapsed simulated time (seconds)
          </text>
        </svg>
      </div>
      <p className="text-sm text-muted">
        {latest ? (
          <>
            Latest check at {formatVirtualTime(latest.record.at)}: baseline{" "}
            <span className="num text-foreground">
              {formatMetric(metric, latest.check?.baseline)}
            </span>
            , enabled{" "}
            <span className="num text-foreground">
              {formatMetric(metric, latest.check?.enabled)}
            </span>
            .
          </>
        ) : running ? (
          "Waiting for the first 30-second simulated check. Turn on traffic to collect samples."
        ) : (
          "No checks yet. Opt in, start the ramp, then simulate traffic."
        )}
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer rounded-control py-2 text-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          View metric values ({records.length} checks)
        </summary>
        {records.length === 0 ? (
          <p className="py-2 text-sm text-muted">No synthetic measurements have been recorded.</p>
        ) : (
          <div className="mt-2 max-h-64 overflow-y-auto">
            <table className="w-full table-fixed text-xs sm:text-sm">
              <caption className="sr-only">
                {metricLabels[metric]} in {unit}. Last 60 checks; a dash means missing evidence.
              </caption>
              <thead className="sticky top-0 bg-background text-muted">
                <tr>
                  <th scope="col" className="w-[30%] py-2 text-left font-normal">
                    Sim. time
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Rollout
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Baseline
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Enabled
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.map(({ record, check }, index) => (
                  <tr key={`${record.at}-${index}`} className="border-t border-border">
                    <th scope="row" className="num py-2 pr-1 text-left font-normal">
                      {formatVirtualTime(record.at)}
                    </th>
                    <td className="num py-2 text-right">{record.rolloutPercent}%</td>
                    <td className="num break-words py-2 pl-1 text-right">
                      {formatMetric(metric, check?.baseline)}
                    </td>
                    <td className="num break-words py-2 pl-1 text-right">
                      {formatMetric(metric, check?.enabled)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      <p className="mt-2 text-xs text-muted">
        Deterministic, balanced synthetic cohorts. Missing evidence is a dash, never zero.
      </p>
    </section>
  );
}
