import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoRolloutMonitor } from "../components/auto-rollout/auto-rollout-monitor";
import { MetricsChart } from "../components/auto-rollout/metrics-chart";
import {
  createDemoRollout,
  setOptIn,
  simulateCycle,
  startRollout,
} from "../lib/auto-rollout/simulator";

test("chart SVG title is a single populated text node during SSR, avoiding hydration mismatch", () => {
  const html = renderToStaticMarkup(createElement(MetricsChart, { history: [], running: false }));
  assert.match(html, /<title[^>]*>Error rate: baseline and enabled synthetic cohorts<\/title>/);
  assert.ok(html.includes("No checks yet"));
  assert.ok(html.includes("No synthetic measurements have been recorded."));
});

test("initial monitor is explicitly synthetic, opted out and unable to start automatically", () => {
  const html = renderToStaticMarkup(createElement(AutoRolloutMonitor));
  assert.ok(html.includes("Browser-only simulation. No production flags are changed."));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start ramp<\/button>/);
  assert.ok(!html.includes('checked=""'));
  assert.ok(html.includes("Off"));
});

test("chart renders actual compared cohort values and distinguishes them from absent evidence", () => {
  const initial = startRollout(setOptIn(createDemoRollout(), true));
  const state = simulateCycle(initial, { traffic: true, injectErrors: true });
  const html = renderToStaticMarkup(
    createElement(MetricsChart, { history: state.history, running: true }),
  );
  assert.ok(html.includes("1.00%"));
  assert.ok(html.includes("20.00%"));
  assert.ok(html.includes("Baseline"));
  assert.ok(html.includes("Enabled"));
  assert.ok(html.includes("View metric values (1"));
});
