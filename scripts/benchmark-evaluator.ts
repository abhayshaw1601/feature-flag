import { performance } from "node:perf_hooks";
import {
  evaluateFlag,
  type EvaluationUser,
  type ServerFlagConfig,
} from "../packages/evaluator/src/index.js";

const evaluations = 100_000;
const warmupEvaluations = 100_000;
const samples = 5;
const users: EvaluationUser[] = Array.from({ length: evaluations }, (_, index) => ({
  id: `benchmark-${index}`,
  attributes: { country: index % 2 === 0 ? "IN" : "US", plan: "pro", age: 30 },
}));
const base: ServerFlagConfig = {
  key: "checkout",
  type: "RELEASE",
  enabled: true,
  rules: { rules: [], defaultServe: { rolloutPercent: 50 } },
  onValue: true,
  offValue: false,
  version: 1,
};
const targeted: ServerFlagConfig = {
  ...base,
  rules: {
    rules: [
      {
        id: "rule_targeted",
        description: "India users on the pro plan",
        conditions: [
          { attribute: "country", operator: "equals", values: ["IN"] },
          { attribute: "plan", operator: "equals", values: ["pro"] },
        ],
        serve: { rolloutPercent: 50 },
      },
    ],
    defaultServe: { rolloutPercent: 10 },
  },
};

function run(flag: ServerFlagConfig, iterations: number): number {
  let enabled = 0;
  for (let i = 0; i < iterations; i += 1) {
    const value = evaluateFlag(flag, users[i % users.length], null);
    if (value === null) throw new Error("Unexpected fallback in benchmark fixture");
    if (value === true) enabled += 1;
  }
  return enabled;
}

console.log(
  `Evaluator local microbenchmark: Node ${process.version}, ${process.platform}/${process.arch}`,
);
console.log(
  `Per workload: ${warmupEvaluations} warmup; ${samples} samples x ${evaluations} timed evaluations.`,
);
console.log(
  "Prebuilt contexts; full validation, matching, hashing, and result allocation included.",
);

for (const [name, flag] of [
  ["default 50%", base],
  ["one AND rule; mixed matches", targeted],
  ["disabled", { ...base, enabled: false }],
] as const) {
  const expectedEnabled = run(flag, warmupEvaluations);
  const timings: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    const enabled = run(flag, evaluations);
    timings.push(performance.now() - start);
    if (enabled !== expectedEnabled) throw new Error("Non-deterministic benchmark result");
    checksum += enabled;
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const average = timings.reduce((sum, elapsed) => sum + elapsed, 0) / samples;
  console.log(
    JSON.stringify({
      workload: name,
      samplesMs: timings.map((elapsed) => Number(elapsed.toFixed(3))),
      medianBatchMs: Number(median.toFixed(3)),
      meanUsPerEvaluation: Number(((average * 1000) / evaluations).toFixed(3)),
      medianBatchUsPerEvaluation: Number(((median * 1000) / evaluations).toFixed(3)),
      medianEvaluationsPerSecond: Math.round((evaluations * 1000) / median),
      enabledPerSample: expectedEnabled,
      checksum,
    }),
  );
}
console.log(
  "Batch averages in this process, not per-call percentiles, network latency, or a production guarantee.",
);
