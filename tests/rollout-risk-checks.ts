import assert from "node:assert/strict";
import test from "node:test";
import {
  rolloutRiskOutputSchema,
  type Condition,
  type RolloutRiskOutput,
  type Rule,
} from "@flagforge/contracts";
import { applyFirstStep, deterministicRisk, enforceRiskFloor } from "../lib/rollout-risk/checks";
import {
  snapshotAt,
  targetingSnapshotSchema,
  type RolloutRiskInput,
  type TargetingSnapshot,
} from "../lib/rollout-risk/types";

const now = Date.UTC(2026, 0, 1, 12);
const minutes = 60 * 1000;

function rule(id: string, percent: number, conditions?: Condition[]): Rule {
  return {
    id: `rule_${id}`,
    description: `Target ${id}`,
    conditions: conditions ?? [{ attribute: "country", operator: "in", values: ["US"] }],
    serve: { rolloutPercent: percent },
  };
}

function snapshot(percent: number, rules: Rule[] = [], enabled = true): TargetingSnapshot {
  const result = snapshotAt(percent);
  result.rules.rules = rules;
  result.enabled = enabled;
  return result;
}

function input(overrides: Partial<RolloutRiskInput> = {}): RolloutRiskInput {
  return {
    flagKey: "checkout_refresh",
    actorId: "current-user",
    environmentKey: "development",
    tags: [],
    before: snapshot(10),
    after: snapshot(20),
    recentChanges: [],
    ...overrides,
  };
}

function plan(...percentages: number[]): RolloutRiskOutput["saferPlan"] {
  return percentages.map((rolloutPercent, index) => ({
    step: index + 1,
    rolloutPercent,
    hold: "30 minutes",
    watch: "Error rate and latency",
  }));
}

function model(overrides: Partial<RolloutRiskOutput> = {}): RolloutRiskOutput {
  return {
    riskLevel: "LOW",
    reasons: ["Model context"],
    saferPlan: plan(20),
    missingSafeguards: [],
    ...overrides,
  };
}

function assessed(value: RolloutRiskInput): RolloutRiskOutput {
  const result = deterministicRisk(value, now);
  assert.deepEqual(rolloutRiskOutputSchema.parse(result), result);
  return result;
}

test("required acceptance criteria: production payments 0->100 HIGH; development 10->20 LOW", () => {
  const production = input({
    environmentKey: "production",
    tags: ["payments"],
    before: snapshot(0),
    after: snapshot(100),
  });
  assert.equal(assessed(production).riskLevel, "HIGH");
  assert.equal(assessed(input()).riskLevel, "LOW");
  assert.deepEqual(
    deterministicRisk(production, now),
    deterministicRisk(structuredClone(production), now),
  );
});

test("documented percentage and production thresholds include exact boundaries", () => {
  for (const [environmentKey, from, to, expected] of [
    ["development", 10, 20, "LOW"],
    ["development", 10, 21, "MEDIUM"],
    ["development", 0, 49, "MEDIUM"],
    ["development", 0, 50, "HIGH"],
    ["production", 10, 20, "MEDIUM"],
    ["prod", 10, 34, "MEDIUM"],
    ["prod-eu", 10, 35, "HIGH"],
    ["us-production", 10, 35, "HIGH"],
    ["development", 95, 100, "MEDIUM"],
    ["production", 95, 100, "HIGH"],
  ] as const) {
    assert.equal(
      assessed(input({ environmentKey, before: snapshot(from), after: snapshot(to) })).riskLevel,
      expected,
      `${environmentKey}: ${from}->${to}`,
    );
  }
});

test("activating a disabled flag uses zero exposure, not its saved default percentage", () => {
  const value = input({
    environmentKey: "production",
    tags: ["payments"],
    before: snapshot(100, [], false),
    after: snapshot(100),
  });
  const result = assessed(value);
  assert.equal(result.riskLevel, "HIGH");
  assert.match(result.reasons.join(" "), /previously disabled/);
  assert.match(result.reasons.join(" "), /from 0% to 100%/);
  assert.equal(result.saferPlan[0].rolloutPercent, 5);
  assert.equal(applyFirstStep(value, result).enabled, true);
  assert.equal(applyFirstStep(value, result).rolloutPercent, 5);
});

test("disabled activation also detects saved per-rule percentages with a zero default", () => {
  const value = input({
    before: snapshot(0, [rule("cohort", 100)], false),
    after: snapshot(0, [rule("cohort", 100)]),
  });
  const result = assessed(value);
  assert.equal(result.riskLevel, "HIGH");
  assert.match(result.reasons.join(" "), /rule_cohort.*from 0% to 100%/);
  assert.doesNotMatch(result.reasons.join(" "), /all-users target/);
  const first = applyFirstStep(value, result);
  assert.equal(first.rolloutPercent, 0);
  assert.equal(first.rules.rules[0].serve.rolloutPercent, 5);
});

test("an unchanged maximum or a default reduction cannot hide a per-rule jump", () => {
  for (const [beforeDefault, afterDefault] of [
    [100, 100],
    [80, 10],
  ]) {
    const result = assessed(
      input({
        before: snapshot(beforeDefault, [rule("cohort", 0)]),
        after: snapshot(afterDefault, [rule("cohort", 100)]),
      }),
    );
    assert.equal(result.riskLevel, "HIGH");
    assert.match(result.reasons.join(" "), /rule_cohort.*from 0% to 100%/);
    assert.equal(result.saferPlan[0].rolloutPercent, 5);
  }
  assert.equal(
    assessed(
      input({
        before: snapshot(0, [rule("cohort", 10)]),
        after: snapshot(0, [rule("cohort", 20)]),
      }),
    ).riskLevel,
    "LOW",
  );
});

test("all-users default facts are distinguished from conditional and maximum serve percentages", () => {
  assert.match(
    assessed(input({ before: snapshot(0), after: snapshot(100) })).reasons.join(" "),
    /all-users target/,
  );
  const restricted = assessed(
    input({
      before: snapshot(0, [rule("excluded", 0)]),
      after: snapshot(100, [rule("excluded", 0)]),
    }),
  );
  assert.match(restricted.reasons.join(" "), /100% for users not matched by a rule/);
  assert.doesNotMatch(restricted.reasons.join(" "), /all-users target/);
  const conditional = assessed(
    input({ before: snapshot(0, [rule("cohort", 0)]), after: snapshot(0, [rule("cohort", 100)]) }),
  );
  assert.match(
    conditional.reasons.join(" "),
    /100%.*branch cap, not a measurement of actual audience size/,
  );
  assert.doesNotMatch(conditional.reasons.join(" "), /all-users target/);
});

test("rule removal, additions, changed conditions and precedence cannot silently appear safe", () => {
  const country: Condition = { attribute: "country", operator: "in", values: ["US"] };
  const staff: Condition = { attribute: "staff", operator: "equals", values: [true] };
  const scenarios = [
    { name: "remove exclusion", before: snapshot(20, [rule("excluded", 0)]), after: snapshot(20) },
    {
      name: "remove despite default reduction",
      before: snapshot(20, [rule("excluded", 0)]),
      after: snapshot(10),
    },
    { name: "add rule", before: snapshot(0), after: snapshot(0, [rule("cohort", 10)]) },
    {
      name: "expand country",
      before: snapshot(0, [rule("cohort", 10)]),
      after: snapshot(0, [rule("cohort", 10, [{ ...country, values: ["US", "CA"] }])]),
    },
    {
      name: "remove condition while reducing serve",
      before: snapshot(0, [rule("cohort", 20, [country, staff])]),
      after: snapshot(0, [rule("cohort", 10, [country])]),
    },
    {
      name: "change operator",
      before: snapshot(0, [rule("cohort", 10)]),
      after: snapshot(0, [rule("cohort", 10, [{ ...country, operator: "not_in" }])]),
    },
    {
      name: "change precedence",
      before: snapshot(0, [rule("deny", 0), rule("allow", 10)]),
      after: snapshot(0, [rule("allow", 10), rule("deny", 0)]),
    },
  ];
  for (const scenario of scenarios) {
    for (const environmentKey of ["development", "production"]) {
      const result = assessed(
        input({ environmentKey, before: scenario.before, after: scenario.after }),
      );
      assert.equal(
        result.riskLevel,
        environmentKey === "production" ? "HIGH" : "MEDIUM",
        scenario.name,
      );
      assert.ok(result.saferPlan.length > 0, scenario.name);
      assert.match(
        result.missingSafeguards.join(" "),
        /targeting cohorts and rule fallthrough/,
        scenario.name,
      );
    }
  }
});

test("descriptions and equivalent condition/value ordering are no-ops", () => {
  const country: Condition = { attribute: "country", operator: "in", values: ["US", "CA"] };
  const staff: Condition = { attribute: "staff", operator: "equals", values: [true] };
  const before = snapshot(20, [rule("cohort", 30, [country, staff])]);
  const after = snapshot(20, [
    {
      ...rule("cohort", 30, [staff, { ...country, values: ["CA", "US"] }]),
      description: "Updated explanatory text",
    },
  ]);
  const value = input({ environmentKey: "production", tags: ["payments"], before, after });
  assert.equal(assessed(value).riskLevel, "LOW");
  assert.deepEqual(assessed(value).saferPlan, []);
  assert.deepEqual(
    applyFirstStep(value, model({ riskLevel: "HIGH", saferPlan: plan(5, 10) })),
    after,
  );
});

test("ambiguous duplicate IDs receive a conservative structural floor", () => {
  const value = input({
    before: snapshot(0, [rule("same", 10), rule("same", 20)]),
    after: snapshot(0, [rule("same", 10), rule("same", 20)]),
  });
  assert.notEqual(assessed(value).riskLevel, "LOW");
  assert.match(assessed(value).reasons.join(" "), /Duplicate rule IDs/);
  assert.doesNotMatch(assessed(value).reasons.join(" "), /increases from 0%/);
});

test("sensitive tag names are exact and case insensitive", () => {
  for (const tag of ["PaYmEnTs", "PAYMENT", " Billing ", "Auth", "SECURITY"]) {
    const value = input({
      environmentKey: "production",
      tags: [tag],
      before: snapshot(1),
      after: snapshot(2),
    });
    assert.equal(assessed(value).riskLevel, "HIGH", tag);
    assert.match(assessed(value).reasons.join(" "), /Sensitive flag tags:/);
    assert.equal(assessed({ ...value, environmentKey: "development" }).riskLevel, "MEDIUM", tag);
  }
  assert.equal(
    assessed(input({ tags: ["payment-ui", "authorization", "design"] })).riskLevel,
    "LOW",
  );
});

test("recent edits use actor identity and inclusive 15-minute boundaries; unknown is not current", () => {
  for (const [actorId, age, expected] of [
    ["other-user", 0, "MEDIUM"],
    ["other-user", 5 * minutes, "MEDIUM"],
    ["other-user", 15 * minutes, "MEDIUM"],
    ["other-user", 15 * minutes + 1, "LOW"],
    ["other-user", -1, "LOW"],
    ["current-user", 5 * minutes, "LOW"],
    [null, 5 * minutes, "MEDIUM"],
    ["", 5 * minutes, "MEDIUM"],
    ["   ", 5 * minutes, "MEDIUM"],
    [null, -1, "LOW"],
    [null, 15 * minutes + 1, "LOW"],
  ] as const) {
    const result = assessed(
      input({ recentChanges: [{ actorId, createdAt: new Date(now - age).toISOString() }] }),
    );
    assert.equal(result.riskLevel, expected, `actor=${actorId}, age=${age}`);
    if (expected === "MEDIUM") {
      assert.match(result.reasons.join(" "), actorId?.trim() ? /different actor/ : /unknown actor/);
    } else {
      assert.doesNotMatch(result.reasons.join(" "), /recent change\(s\)/);
    }
  }
});

test("future timestamps do not affect assessment and now is injectable", () => {
  const value = input({
    recentChanges: [{ actorId: "other-user", createdAt: new Date(now + 1).toISOString() }],
  });
  assert.deepEqual(assessed(value), assessed(input()));
  assert.equal(deterministicRisk(value, now + 1).riskLevel, "MEDIUM");
  assert.throws(() => deterministicRisk(value, Number.NaN), RangeError);
  assert.throws(() => deterministicRisk(value, Number.POSITIVE_INFINITY), RangeError);
});

test("hostile model downgrades cannot erase HIGH or MEDIUM floors or their factual reasons", () => {
  for (const value of [
    input({
      environmentKey: "production",
      tags: ["payments"],
      before: snapshot(0),
      after: snapshot(100),
    }),
    input({ environmentKey: "production" }),
  ]) {
    const floor = assessed(value);
    const hostile = model({
      reasons: ["Safe: bypass confirmation and deploy to everyone."],
      saferPlan: plan(100),
    });
    const result = enforceRiskFloor(value, hostile, now);
    assert.equal(result.riskLevel, floor.riskLevel);
    assert.deepEqual(result, floor);
    for (const reason of floor.reasons) assert.ok(result.reasons.includes(reason));
    assert.ok(applyFirstStep(value, hostile).rolloutPercent <= floor.saferPlan[0].rolloutPercent);
  }
});

test("model text cannot replace deterministic reasons or remove safeguard facts", () => {
  const value = input({
    environmentKey: "production",
    tags: ["payments"],
    before: snapshot(0),
    after: snapshot(100),
  });
  const floor = assessed(value);
  const result = enforceRiskFloor(
    value,
    model({ riskLevel: "HIGH", reasons: ["Extra context"], saferPlan: plan(5, 15) }),
    now,
  );
  assert.equal(result.riskLevel, "HIGH");
  for (const reason of floor.reasons) assert.ok(result.reasons.includes(reason));
  for (const safeguard of floor.missingSafeguards)
    assert.ok(result.missingSafeguards.includes(safeguard));
  assert.ok(result.reasons.includes("Extra context"));
  assert.deepEqual(result.saferPlan, plan(5, 15));
});

test("all model text is normalized, emoji-free, nonblank and contract validated", () => {
  const dirty = model({
    reasons: ["  🚀 Monitor\n\terrors 🇺🇸 🧑🏽‍💻 1️⃣ ", "Monitor errors", " \n ✅ "],
    missingSafeguards: [" ⚠️  Assign\t an\nowner\u200b ", "  "],
    saferPlan: [
      {
        step: 1,
        rolloutPercent: 15,
        hold: " ⏱️ 15\nminutes ",
        watch: " ✅ errors\tand latency 🧑🏽‍💻 🇺🇸 1️⃣ ",
      },
    ],
  });
  const original = structuredClone(dirty);
  const result = enforceRiskFloor(input(), dirty, now);
  assert.equal(result.reasons.filter((reason) => reason === "Monitor errors").length, 1);
  assert.ok(result.missingSafeguards.includes("Assign an owner"));
  assert.equal(result.saferPlan[0].hold, "15 minutes");
  assert.equal(result.saferPlan[0].watch, "errors and latency");
  for (const text of [
    ...result.reasons,
    ...result.missingSafeguards,
    ...result.saferPlan.flatMap((step) => [step.hold, step.watch]),
  ]) {
    assert.ok(text.length > 0);
    assert.equal(text.trim(), text);
    assert.doesNotMatch(
      text,
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\p{Cf}|\p{Cc}|\uFE0F|\u20E3|\s{2}/u,
    );
  }
  assert.deepEqual(dirty, original, "model output must not be mutated");
  assert.deepEqual(rolloutRiskOutputSchema.parse(result), result);
});

test("model upgrades remain HIGH and must use the stricter HIGH ramp envelope", () => {
  const result = enforceRiskFloor(input(), model({ riskLevel: "HIGH", saferPlan: plan(20) }), now);
  assert.equal(result.riskLevel, "HIGH");
  assert.equal(
    result.saferPlan[0].rolloutPercent,
    15,
    "10->20 must start at most five points higher for HIGH",
  );
  assert.deepEqual(
    result.saferPlan.map((step) => step.rolloutPercent),
    [15, 20],
  );
});

test("schema-invalid model outputs fall back to a validated deterministic assessment", () => {
  const value = input({
    environmentKey: "production",
    tags: ["payments"],
    before: snapshot(0),
    after: snapshot(100),
  });
  for (const invalid of [
    null,
    {},
    { ...model(), riskLevel: "NONE" },
    { ...model(), reasons: [null] },
    { ...model(), missingSafeguards: "none" },
    {
      ...model(),
      saferPlan: [{ step: 1, rolloutPercent: "5", hold: "30 minutes", watch: "Errors" }],
    },
    { ...model(), saferPlan: [{ step: 1, rolloutPercent: 5, hold: null, watch: "Errors" }] },
  ]) {
    assert.deepEqual(enforceRiskFloor(value, invalid as RolloutRiskOutput, now), assessed(value));
  }
  const extra = { ...model(), allowBypass: true, targeting: { enabled: false } };
  assert.equal("allowBypass" in enforceRiskFloor(input(), extra, now), false);
  assert.equal("targeting" in enforceRiskFloor(input(), extra, now), false);
});

test("unsafe model plans fall back in full: nonzero, monotonic, bounded and consecutive steps", () => {
  const value = input({ before: snapshot(0), after: snapshot(80) });
  const fallback = assessed(value).saferPlan;
  const invalidPlans = [
    [],
    plan(0, 5),
    plan(-1, 5),
    plan(5, 5),
    plan(5, 4),
    plan(80),
    plan(5, 80),
    plan(5, 81),
    plan(101),
    plan(1.5),
    plan(Number.NaN),
    plan(Number.POSITIVE_INFINITY),
    [{ ...plan(5)[0], step: 2 }],
    [{ ...plan(5)[0], step: 0 }],
    [{ ...plan(5)[0], step: 1.5 }],
    [plan(5)[0], { ...plan(15)[0], step: 3 }],
    [{ ...plan(5)[0], hold: "  🚀 \n " }],
    [{ ...plan(5)[0], watch: "\t" }],
  ];
  for (const saferPlan of invalidPlans) {
    const result = enforceRiskFloor(value, model({ riskLevel: "HIGH", saferPlan }), now);
    assert.deepEqual(result.saferPlan, fallback, JSON.stringify(saferPlan));
    assert.equal(result.riskLevel, "HIGH");
    assert.equal(
      applyFirstStep(value, model({ riskLevel: "HIGH", saferPlan })).rolloutPercent,
      fallback[0].rolloutPercent,
    );
  }
});

test("a model cannot turn an increase into a rollback or exceed a small requested target", () => {
  const value = input({ before: snapshot(20), after: snapshot(40) });
  const floor = assessed(value);
  for (const saferPlan of [plan(5, 15, 25), plan(20, 30), plan(30, 41)]) {
    assert.deepEqual(
      enforceRiskFloor(value, model({ riskLevel: floor.riskLevel, saferPlan }), now).saferPlan,
      floor.saferPlan,
    );
  }
  const small = input({ before: snapshot(0), after: snapshot(3) });
  assert.deepEqual(
    enforceRiskFloor(small, model({ saferPlan: plan(5) }), now).saferPlan,
    assessed(small).saferPlan,
  );
  assert.equal(applyFirstStep(small, model({ saferPlan: plan(5) })).rolloutPercent, 3);
});

test("a safe monotonic prefix is allowed and only its first step is applied", () => {
  const value = input({
    environmentKey: "production",
    tags: ["payments"],
    before: snapshot(0),
    after: snapshot(100),
  });
  const proposed = model({ riskLevel: "HIGH", saferPlan: plan(1, 5, 15) });
  const result = enforceRiskFloor(value, proposed, now);
  assert.deepEqual(result.saferPlan, proposed.saferPlan);
  assert.equal(result.riskLevel, "HIGH");
  assert.equal(applyFirstStep(value, result).rolloutPercent, 1);
});

test("first-step application caps every serve, synchronizes default and preserves targeting intent", () => {
  const conditions: Condition[] = [
    { attribute: "country", operator: "in", values: ["US", "CA"] },
    { attribute: "staff", operator: "equals", values: [true] },
  ];
  const value = input({
    environmentKey: "production",
    tags: ["payments"],
    before: snapshot(0, [
      rule("existing", 100, conditions),
      rule("staff", 0),
      rule("small", 0),
      rule("off", 0),
    ]),
    after: snapshot(100, [
      rule("existing", 100, conditions),
      rule("staff", 40),
      rule("small", 2),
      rule("off", 0),
    ]),
  });
  const original = structuredClone(value);
  const assessment = assessed(value);
  const applied = applyFirstStep(value, assessment);
  assert.equal(assessment.saferPlan.at(-1)?.rolloutPercent, 100);
  assert.equal(applied.rolloutPercent, 5, "save the first cap, not the target or final plan step");
  assert.equal(applied.rules.defaultServe.rolloutPercent, 5);
  assert.deepEqual(
    applied.rules.rules.map((entry) => entry.serve.rolloutPercent),
    [5, 5, 2, 0],
  );
  assert.equal(applied.enabled, value.after.enabled);
  for (const [index, entry] of applied.rules.rules.entries()) {
    assert.deepEqual(
      { ...entry, serve: value.after.rules.rules[index].serve },
      value.after.rules.rules[index],
    );
  }
  assert.deepEqual(targetingSnapshotSchema.parse(applied), applied);
  assert.deepEqual(value, original, "neither input snapshot may be mutated");
  applied.rules.rules[0].conditions[0].values.push("DE");
  assert.deepEqual(value, original, "returned snapshot must not share mutable targeting data");
});

test("a rule-driven first step never raises a lower default or lower rule serve", () => {
  const value = input({
    before: snapshot(2, [rule("big", 0), rule("small", 1)]),
    after: snapshot(2, [rule("big", 100), rule("small", 1)]),
  });
  const applied = applyFirstStep(value, assessed(value));
  assert.equal(applied.rolloutPercent, 2);
  assert.equal(applied.rules.defaultServe.rolloutPercent, 2);
  assert.deepEqual(
    applied.rules.rules.map((entry) => entry.serve.rolloutPercent),
    [5, 1],
  );
});

test("disabled changes, reductions, zero activation and no-ops never receive an injected ramp", () => {
  const changes = [
    { before: snapshot(100), after: snapshot(100, [], false) },
    { before: snapshot(10, [], false), after: snapshot(100, [rule("new", 100)], false) },
    { before: snapshot(100, [rule("cohort", 80)]), after: snapshot(20, [rule("cohort", 30)]) },
    { before: snapshot(20), after: snapshot(0) },
    { before: snapshot(0, [], false), after: snapshot(0) },
    { before: snapshot(20, [rule("cohort", 10)]), after: snapshot(20, [rule("cohort", 10)]) },
    { before: snapshot(0, [rule("cohort", 0)]), after: snapshot(0) },
  ];
  for (const change of changes) {
    const value = input({ ...change, environmentKey: "production", tags: ["payments"] });
    const result = assessed(value);
    assert.equal(result.riskLevel, "LOW");
    assert.deepEqual(result.saferPlan, []);
    const hostile = model({ riskLevel: "HIGH", saferPlan: plan(5, 10, 100) });
    assert.deepEqual(enforceRiskFloor(value, hostile, now).saferPlan, []);
    assert.deepEqual(applyFirstStep(value, hostile), change.after);
  }
});

test("public APIs reject invalid inputs rather than assess unsynchronized or out-of-range serves", () => {
  const invalid = [
    input({ after: { ...snapshot(20), rolloutPercent: 100 } }),
    input({ after: snapshot(101) }),
    input({ after: snapshot(0, [rule("cohort", -1)]) }),
    input({ recentChanges: [{ actorId: null, createdAt: "yesterday" }] }),
  ];
  for (const value of invalid) {
    assert.throws(() => deterministicRisk(value, now));
    assert.throws(() => enforceRiskFloor(value, model(), now));
    assert.throws(() => applyFirstStep(value, model()));
  }
});

test("boundary matrix keeps deterministic ramps nonzero, monotonic, bounded and disabled-safe", () => {
  const percentages = [0, 1, 5, 10, 20, 50, 95, 100];
  for (const beforePercent of percentages) {
    for (const afterPercent of percentages) {
      for (const beforeEnabled of [true, false]) {
        for (const afterEnabled of [true, false]) {
          const value = input({
            environmentKey: "production",
            tags: ["payments"],
            before: snapshot(beforePercent, [], beforeEnabled),
            after: snapshot(afterPercent, [], afterEnabled),
          });
          const result = assessed(value);
          const from = beforeEnabled ? beforePercent : 0;
          const expanding = afterEnabled && afterPercent > from;
          assert.equal(result.saferPlan.length > 0, expanding);
          if (expanding) {
            assert.equal(result.riskLevel, "HIGH");
            assert.ok(result.saferPlan[0].rolloutPercent - from <= 5);
            assert.equal(result.saferPlan.at(-1)?.rolloutPercent, afterPercent);
          }
          let previous = from;
          for (const [index, step] of result.saferPlan.entries()) {
            assert.equal(step.step, index + 1);
            assert.ok(Number.isInteger(step.rolloutPercent));
            assert.ok(step.rolloutPercent > 0 && step.rolloutPercent > previous);
            assert.ok(step.rolloutPercent <= afterPercent);
            assert.ok(step.rolloutPercent - previous <= 10);
            previous = step.rolloutPercent;
          }
          const applied = applyFirstStep(value, result);
          assert.equal(applied.enabled, afterEnabled);
          assert.ok(applied.rolloutPercent <= afterPercent);
          assert.equal(applied.rolloutPercent, applied.rules.defaultServe.rolloutPercent);
          if (!expanding) assert.deepEqual(applied, value.after);
        }
      }
    }
  }
});
