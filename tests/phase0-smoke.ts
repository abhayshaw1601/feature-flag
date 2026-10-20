import assert from "node:assert/strict";
import {
  flagCreationOutputSchema,
  ruleSetSchema,
  sdkConfigResponseSchema,
} from "@flagforge/contracts";
import { demoFlags, demoEnvironments } from "../lib/seed-data";

assert.equal(demoFlags.length, 25, "Phase 0 must expose 25 deterministic flags");
assert.equal(demoEnvironments.length, 3, "Phase 0 must expose three environments");
assert.ok(
  demoFlags.every((flag) => flag.environments.length === 3),
  "Every flag needs one config per environment",
);
assert.ok(
  demoFlags.some((flag) => flag.type === "EXPERIMENT"),
  "Seed data needs experiment flags",
);
assert.ok(
  demoFlags.some((flag) => flag.archivedAt),
  "Seed data needs an archived flag",
);
assert.ok(
  demoFlags.some((flag) =>
    flag.environments.some(
      (environment) => environment.rolloutPercent > 0 && environment.rolloutPercent < 100,
    ),
  ),
  "Seed data needs partial rollouts",
);

const firstRuleSet = demoFlags[3]?.environments[0]?.rules;
assert.ok(firstRuleSet, "A seeded flag should carry a rule set");
assert.doesNotThrow(() => ruleSetSchema.parse(firstRuleSet));

const creationOutput = {
  key: "checkout_refresh",
  name: "Checkout refresh",
  type: "RELEASE" as const,
  description: "Gate a new checkout layout.",
  environments: demoEnvironments.map((environment) => ({
    environmentKey: environment.key,
    enabled: false,
    rules: { rules: [], defaultServe: { rolloutPercent: 0 } },
  })),
  assumptions: [],
  warnings: [],
};
assert.doesNotThrow(() => flagCreationOutputSchema.parse(creationOutput));
assert.doesNotThrow(() =>
  sdkConfigResponseSchema.parse({ environmentKey: "staging", version: 1, flags: {} }),
);

console.log(
  "Phase 0 smoke checks passed: 25 flags, three environments, rule and API contracts parse.",
);
