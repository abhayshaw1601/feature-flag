import { deterministicExplanation } from "../lib/auto-rollout/explanation";
import {
  createDemoRollout,
  setOptIn,
  simulateCycle,
  startRollout,
} from "../lib/auto-rollout/simulator";

const args = process.argv.slice(2);
if (
  args.some(
    (arg) =>
      !["--opt-in", "--inject-errors", "--no-traffic"].includes(arg) && !/^--cycles=\d+$/.test(arg),
  )
) {
  throw new Error(
    "Usage: npm run simulate:auto-rollout -- --opt-in [--inject-errors] [--no-traffic] [--cycles=8]",
  );
}
const cycles = Number(args.find((arg) => arg.startsWith("--cycles="))?.split("=")[1] ?? 8);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 120)
  throw new Error("Choose 1 to 120 cycles.");
let state = createDemoRollout();
console.log(
  "Browser/CLI fixture simulation only: no database, network, AI calls, or production writes.",
);
if (!args.includes("--opt-in")) {
  console.log("Automation is off by default. Add --opt-in to run the synthetic rollout.");
} else {
  state = startRollout(setOptIn(state, true));
  for (let index = 0; index < cycles && state.status === "running"; index++) {
    state = simulateCycle(state, {
      traffic: !args.includes("--no-traffic"),
      injectErrors: args.includes("--inject-errors"),
    });
    const result = state.history.at(-1)!;
    console.log(
      `${state.now / 1000}s: ${result.decision}; flag ${state.enabled ? "on" : "off"} at ${state.rolloutPercent}%. ${deterministicExplanation(result).explanation}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        status: state.status,
        enabled: state.enabled,
        rolloutPercent: state.rolloutPercent,
        audit: state.audit,
        notifications: state.notifications,
      },
      null,
      2,
    ),
  );
}
