import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Contracts from "../packages/contracts/src/index.js";
import {
  bucket,
  evaluateDetailed,
  evaluateFlag,
  matchesCondition,
  murmur3,
  type Condition,
  type EvaluationUser,
  type JsonScalar,
  type JsonValue,
  type Rule,
  type RuleOperator,
  type ServerFlagConfig,
} from "../packages/evaluator/src/index.js";

function makeUser(attributes: Record<string, JsonScalar> = { plan: "pro" }): EvaluationUser {
  return { id: "user-1", attributes };
}

function makeCondition(
  operator: RuleOperator = "equals",
  values: JsonScalar[] = ["pro"],
  attribute = "plan",
): Condition {
  return { attribute, operator, values };
}

function makeRule(id: string, rolloutPercent: number, conditions = [makeCondition()]): Rule {
  return { id, description: "Targeted users", conditions, serve: { rolloutPercent } };
}

function makeFlag(
  rolloutPercent = 100,
  overrides: Partial<ServerFlagConfig> = {},
): ServerFlagConfig {
  return {
    key: "checkout",
    type: "RELEASE",
    enabled: true,
    rules: { rules: [], defaultServe: { rolloutPercent } },
    onValue: true,
    offValue: false,
    version: 1,
    ...overrides,
  };
}

// Compile-time checks are bidirectional, not just assertions on hand-picked fixtures.
type Compatible<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractCompatibility: [
  Compatible<JsonValue, Contracts.JsonValue>,
  Compatible<EvaluationUser, Contracts.EvaluationUser>,
  Compatible<ServerFlagConfig, Contracts.ServerFlagConfig>,
  Compatible<Condition, Contracts.Condition>,
] = [true, true, true, true];

test("public structural types remain compatible with contracts", () => {
  assert.deepEqual(contractCompatibility, [true, true, true, true]);
});

test("MurmurHash3 seed-0 canonical vectors are stable unsigned 32-bit integers", () => {
  // SMHasher/Ian Boyd vectors, also published in hajimes/mmh3 tests/test_mmh3.py.
  const vectors: [string, number][] = [
    ["", 0x00000000],
    ["foo", 0xf6a5c420],
    ["abc", 0xb3dd93fa],
    ["hello", 0x248bfa47],
    ["The quick brown fox jumps over the lazy dog", 0x2e4ff723],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 0xee925b90],
    ["!", 0x72661cf4],
    ["!C", 0xa0f7b07a],
    ["!Ce", 0x7e4a8634],
    ["\0", 0x514e28b7],
    ["\0\0", 0x30f4c306],
    ["\0\0\0", 0x85f0b427],
    ["\0\0\0\0", 0x2362f9de],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(murmur3(input), expected, JSON.stringify(input));
    assert.equal(murmur3(input), murmur3(input));
    assert.ok(Number.isInteger(murmur3(input)) && murmur3(input) >= 0);
    assert.ok(murmur3(input) <= 0xffffffff);
  }
});

test("UTF-8 hashing covers multibyte characters, byte boundaries, and astral code points", () => {
  // Independently calculated with a byte-oriented Python/struct x86_32 reference.
  const vectors: [string, number][] = [
    ["é", 0x10110787],
    ["π", 0xf1954df6],
    ["你好", 0x141baa24],
    ["\u{10000}", 0x61c178ff],
    ["aé日\u{10000}z", 0x258ed3de],
    ["éé", 0x467811e5],
    ["\u007f\u0080\u07ff\u0800\uffff\u{10ffff}", 0x14385515],
    ["\ufffd", 0xb69ca6c1],
  ];
  for (const [input, expected] of vectors) assert.equal(murmur3(input), expected);
  assert.equal(murmur3("\ud800"), 0xb69ca6c1);
  assert.equal(murmur3("\udfff"), 0xb69ca6c1);
  assert.equal(murmur3("x\ud800a\udc00"), murmur3("x\ufffda\ufffd"));
  assert.equal(murmur3("\ud800\ud800\udc00"), murmur3("\ufffd\u{10000}"));
  assert.notEqual(murmur3("é"), murmur3("e\u0301"), "does not normalize Unicode");
});

test("buckets use the exact colon-delimited seed, independent of process state", () => {
  assert.equal(bucket("checkout", "user-0"), 9724);
  assert.equal(bucket("checkout", "user-1"), 2333);
  assert.equal(bucket("checkout", "user-1"), murmur3("checkout:user-1") % 10000);
  assert.equal(bucket("日本", "é"), murmur3("日本:é") % 10000);
  assert.equal(bucket("a:b", "c"), bucket("a", "b:c"), "specified delimiter is not escaped");
});

const operatorCases: [RuleOperator, JsonScalar, JsonScalar[], boolean][] = [
  ["equals", "pro", ["free", "pro"], true],
  ["equals", "PRO", ["pro"], false],
  ["equals", 1, ["1"], false],
  ["equals", false, [0], false],
  ["equals", null, [null], true],
  ["equals", "", [""], true],
  ["equals", false, [false], true],
  ["equals", 0, [0], true],
  ["not_equals", "pro", ["free", "pro"], false],
  ["not_equals", "pro", ["free", "basic"], true],
  ["not_equals", 1, ["1"], true],
  ["not_equals", null, [null], false],
  ["in", 2, [1, 2, 3], true],
  ["in", "2", [1, 2, 3], false],
  ["in", false, [null, false], true],
  ["not_in", 4, [1, 2, 3], true],
  ["not_in", 2, [1, 2, 3], false],
  ["not_in", null, [null, false], false],
  ["contains", "team-pro-plan", ["free", "pro"], true],
  ["contains", "PRO", ["pro"], false],
  ["contains", 123, ["2"], false],
  ["contains", "123", [2], false],
  ["contains", "abc", [""], true],
  ["starts_with", "pro-plan", ["basic", "pro"], true],
  ["starts_with", "team-pro", ["pro"], false],
  ["starts_with", "Pro", ["pro"], false],
  ["starts_with", 123, ["1"], false],
  ["starts_with", "123", [1], false],
  ["starts_with", "", [""], true],
  ["greater_than", 10, [20, 5], true],
  ["greater_than", 10, [10], false],
  ["greater_than", "10", [5], false],
  ["greater_than", 10, ["5"], false],
  ["greater_than", 0, [-0.5], true],
  ["greater_than", false, [-1], false],
  ["less_than", 10, [5, 20], true],
  ["less_than", 10, [10], false],
  ["less_than", "10", [20], false],
  ["less_than", 10, ["20"], false],
  ["less_than", -0.5, [0], true],
  ["less_than", null, [1], false],
];

for (const operator of new Set(operatorCases.map(([operator]) => operator))) {
  test(`${operator}: strict scalar semantics, multiple operands, and absent attributes`, () => {
    for (const [op, actual, values, expected] of operatorCases) {
      if (op !== operator) continue;
      assert.equal(
        matchesCondition(makeCondition(op, values), makeUser({ plan: actual })),
        expected,
        JSON.stringify({ op, actual, values }),
      );
    }
    assert.equal(matchesCondition(makeCondition(operator), makeUser({})), false);
  });
}

test("numeric comparisons reject nonfinite values on either side", () => {
  for (const operator of ["greater_than", "less_than"] as const) {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      assert.equal(
        matchesCondition(makeCondition(operator, [0]), makeUser({ plan: invalid })),
        false,
      );
      assert.equal(
        matchesCondition(makeCondition(operator, [invalid]), makeUser({ plan: 0 })),
        false,
      );
    }
  }
});

test("all operators participate in AND targeting and return the matching rule ID", () => {
  const conditions: Condition[] = [
    makeCondition("equals", ["pro"]),
    makeCondition("not_equals", ["free"]),
    makeCondition("in", ["pro", "enterprise"]),
    makeCondition("not_in", ["basic", "free"]),
    makeCondition("contains", ["r"]),
    makeCondition("starts_with", ["pr"]),
    makeCondition("greater_than", [18], "age"),
    makeCondition("less_than", [65], "age"),
  ];
  const flag = makeFlag(0);
  flag.rules.rules.push(makeRule("rule_all", 100, conditions));
  assert.deepEqual(evaluateDetailed(flag, makeUser({ plan: "pro", age: 30 }), null), {
    value: true,
    variation: "on",
    reason: "rule_match",
    ruleId: "rule_all",
  });
  assert.equal(evaluateFlag(flag, makeUser({ plan: "pro", age: 18 }), null), false);
  assert.equal(evaluateFlag(flag, makeUser({ plan: "pro" }), null), false);
});

test("first matching rule wins, including an off bucket before later on rules", () => {
  const flag = makeFlag(100);
  flag.rules.rules = [
    makeRule("rule_nonmatch", 100, [makeCondition("equals", ["free"])]),
    makeRule("rule_first", 0),
    makeRule("rule_later", 100),
  ];
  assert.deepEqual(evaluateDetailed(flag, makeUser(), null), {
    value: false,
    variation: "off",
    reason: "rule_match",
    ruleId: "rule_first",
  });
  flag.rules.rules.reverse();
  assert.equal(evaluateDetailed(flag, makeUser(), null).ruleId, "rule_later");
  assert.equal(evaluateFlag(flag, makeUser(), null), true);
});

test("nonmatching rules use defaultServe and off never becomes fallback", () => {
  const flag = makeFlag(0);
  flag.rules.rules = [makeRule("rule_missing", 100, [makeCondition("not_in", ["free"])])];
  assert.deepEqual(evaluateDetailed(flag, makeUser({}), "fallback"), {
    value: false,
    variation: "off",
    reason: "default",
  });
  flag.rules.defaultServe.rolloutPercent = 100;
  assert.deepEqual(evaluateDetailed(flag, makeUser({}), "fallback"), {
    value: true,
    variation: "on",
    reason: "default",
  });
});

test("a valid disabled flag always returns offValue before checking context or matching rules", () => {
  const flag = makeFlag(100, { enabled: false, offValue: { disabled: true } });
  flag.rules.rules = [makeRule("rule_on", 100)];
  for (const user of [makeUser(), null, undefined, { id: "", attributes: {} }]) {
    assert.deepEqual(evaluateDetailed(flag, user, "fallback"), {
      value: { disabled: true },
      variation: "off",
      reason: "disabled",
    });
  }
});

test("JSON values and fallbacks retain exact values and references, including falsy values", () => {
  const values: JsonValue[] = [
    false,
    true,
    0,
    -2.5,
    "",
    "pro",
    null,
    [],
    {},
    { a: [0, false, null] },
  ];
  for (const value of values) {
    const on = makeFlag(100, { onValue: value });
    const off = makeFlag(0, { offValue: value });
    assert.strictEqual(evaluateFlag(on, makeUser(), "fallback"), value);
    assert.strictEqual(evaluateFlag(off, makeUser(), "fallback"), value);
    assert.strictEqual(evaluateFlag(undefined, makeUser(), value), value);
    assert.equal(evaluateDetailed(on, makeUser(), null).variation, "on");
    assert.equal(evaluateDetailed(off, makeUser(), null).variation, "off");
  }
  const same = makeFlag(100, { onValue: false, offValue: false });
  assert.equal(evaluateDetailed(same, makeUser(), true).variation, "on");
});

test("all flag categories can return arbitrary JSON rather than coercing to booleans", () => {
  for (const type of ["RELEASE", "OPS", "EXPERIMENT", "PERMISSION"] as const) {
    assert.deepEqual(
      evaluateFlag(makeFlag(100, { type, onValue: { variant: "b" } }), makeUser(), 0),
      {
        variant: "b",
      },
    );
  }
});

test("invalid config safely falls back, including malformed rules not selected by targeting", () => {
  const valid = makeFlag();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const badConfigs: unknown[] = [
    undefined,
    null,
    false,
    [],
    {},
    { ...valid, key: 42 },
    { ...valid, type: "BOOLEAN" },
    { ...valid, enabled: "true" },
    ...[-1, 0.5, NaN, Infinity, "1", undefined].map((version) => ({ ...valid, version })),
    ...[
      undefined,
      NaN,
      Infinity,
      1n,
      () => true,
      new Date(),
      cyclic,
      [undefined],
      new Array(1),
    ].map((onValue) => ({ ...valid, onValue })),
    { ...valid, offValue: undefined },
    { ...valid, rules: null },
    { ...valid, rules: [] },
    { ...valid, rules: { rules: [] } },
    ...[-1, 101, 10.5, NaN, Infinity, "50", undefined].map((rolloutPercent) => ({
      ...valid,
      rules: { rules: [], defaultServe: { rolloutPercent } },
    })),
    ...[
      { ...makeRule("rule_a", 100), conditions: [] },
      { ...makeRule("rule_a", 100), id: "invalid" },
      { ...makeRule("rule_a", 100), description: "" },
      { ...makeRule("rule_a", 100), serve: { rolloutPercent: 101 } },
      { ...makeRule("rule_a", 100), conditions: [{ ...makeCondition(), operator: "unknown" }] },
      { ...makeRule("rule_a", 100), conditions: [{ ...makeCondition(), values: [] }] },
      { ...makeRule("rule_a", 100), conditions: [{ ...makeCondition(), values: [NaN] }] },
      { ...makeRule("rule_a", 100), conditions: [{ ...makeCondition(), attribute: "" }] },
    ].map((rule) => ({
      ...valid,
      rules: { ...valid.rules, rules: [makeRule("rule_on", 100), rule] },
    })),
    { ...valid, rules: { ...valid.rules, rules: new Array(1) } },
    { ...valid, rules: { ...valid.rules, rules: Array(51).fill(makeRule("rule_a", 100)) } },
    Object.create(valid),
  ];
  for (const [index, flag] of badConfigs.entries()) {
    assert.deepEqual(
      evaluateDetailed(flag as ServerFlagConfig, makeUser(), "safe"),
      {
        value: "safe",
        variation: "fallback",
        reason: "invalid_config",
      },
      `invalid config ${index}`,
    );
  }
  assert.equal(
    evaluateDetailed({ ...valid, enabled: false, onValue: NaN }, null, 0).reason,
    "invalid_config",
  );
});

test("invalid user contexts fail closed and never coerce IDs or attribute values", () => {
  const contexts: unknown[] = [
    undefined,
    null,
    false,
    [],
    {},
    { id: "", attributes: {} },
    { id: 1, attributes: {} },
    { id: "user" },
    ...[null, [], new Date(), new Map(), "pro"].map((attributes) => ({ id: "user", attributes })),
    ...[undefined, NaN, Infinity, [], {}, () => true].map((plan) => ({
      id: "user",
      attributes: { plan },
    })),
    Object.create(makeUser()),
  ];
  for (const user of contexts) {
    assert.deepEqual(evaluateDetailed(makeFlag(), user as EvaluationUser, 0), {
      value: 0,
      variation: "fallback",
      reason: "invalid_context",
    });
    assert.equal(matchesCondition(makeCondition("not_equals"), user as EvaluationUser), false);
  }
});

test("prototype names never accidentally match, including negated conditions", () => {
  for (const attribute of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    for (const operator of ["equals", "not_equals", "in", "not_in"] as const) {
      assert.equal(
        matchesCondition(makeCondition(operator, ["pro"], attribute), makeUser({})),
        false,
      );
    }
  }
  const inherited = Object.create({ plan: "pro" }) as Record<string, JsonScalar>;
  assert.equal(matchesCondition(makeCondition(), makeUser(inherited)), false);
  assert.equal(matchesCondition(makeCondition("not_equals"), makeUser(inherited)), false);
  const own = JSON.parse('{"__proto__":"pro","constructor":"pro","toString":"pro"}') as Record<
    string,
    JsonScalar
  >;
  for (const attribute of Object.keys(own)) {
    assert.equal(
      matchesCondition(makeCondition("equals", ["pro"], attribute), makeUser(own)),
      true,
    );
  }
  const nullPrototype = Object.assign(Object.create(null), { plan: "pro" });
  assert.equal(matchesCondition(makeCondition(), makeUser(nullPrototype)), true);
  const hidden = Object.defineProperty({}, "plan", { value: "pro", enumerable: false });
  assert.equal(matchesCondition(makeCondition("not_equals"), makeUser(hidden)), false);
});

test("attribute names are literal: no dotted traversal or implicit user ID lookup", () => {
  assert.equal(matchesCondition(makeCondition("equals", ["user-1"], "id"), makeUser({})), false);
  assert.equal(
    matchesCondition(
      makeCondition("equals", ["pro"], "account.plan"),
      makeUser({ "account.plan": "pro" }),
    ),
    true,
  );
});

test("accessors and throwing proxies fail safely without executing getters", () => {
  let getterCalls = 0;
  const getter = {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    },
  };
  const flag = Object.defineProperty(makeFlag(), "enabled", getter);
  const user = makeUser(Object.defineProperty({}, "plan", getter));
  assert.equal(evaluateDetailed(flag, makeUser(), null).reason, "invalid_config");
  assert.equal(evaluateDetailed(makeFlag(), user, null).reason, "invalid_context");
  assert.equal(matchesCondition(makeCondition("not_in"), user), false);
  assert.equal(getterCalls, 0);
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("invalid input");
      },
    },
  );
  assert.equal(
    evaluateDetailed(proxy as ServerFlagConfig, makeUser(), null).reason,
    "invalid_config",
  );
  assert.equal(
    evaluateDetailed(makeFlag(), proxy as EvaluationUser, null).reason,
    "invalid_context",
  );
  assert.equal(matchesCondition(proxy as Condition, makeUser()), false);
});

test("evaluation is pure for frozen inputs and observes subsequent changes without stale caches", () => {
  function freeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  const flag = freeze(makeFlag(50));
  const user = freeze(makeUser());
  const before = JSON.stringify({ flag, user });
  assert.deepEqual(evaluateDetailed(flag, user, null), evaluateDetailed(flag, user, null));
  assert.equal(JSON.stringify({ flag, user }), before);
  const mutable = makeFlag(0);
  assert.equal(evaluateFlag(mutable, user, null), false);
  mutable.rules.defaultServe.rolloutPercent = 100;
  mutable.onValue = "updated";
  assert.equal(evaluateFlag(mutable, user, null), "updated");
  const shared = { value: true };
  assert.deepEqual(evaluateFlag(makeFlag(100, { onValue: [shared, shared] }), user, null), [
    shared,
    shared,
  ]);
});

test("bucket threshold is exclusive and 0/100 percent are exact endpoints", () => {
  const boundaryUsers = new Map<number, EvaluationUser>();
  for (let i = 0; i < 200_000 && boundaryUsers.size < 2; i += 1) {
    const user = { id: `boundary-${i}`, attributes: {} };
    const slot = bucket("checkout", user.id);
    if (slot === 999 || slot === 1000) boundaryUsers.set(slot, user);
  }
  assert.equal(boundaryUsers.size, 2);
  assert.equal(evaluateFlag(makeFlag(10), boundaryUsers.get(999), null), true);
  assert.equal(evaluateFlag(makeFlag(10), boundaryUsers.get(1000), null), false);
  for (let i = 0; i < 1000; i += 1) {
    const user = { id: `endpoint-${i}`, attributes: {} };
    assert.equal(evaluateFlag(makeFlag(0), user, null), false);
    assert.equal(evaluateFlag(makeFlag(100), user, null), true);
  }
});

test("100k users: 10/50 percent distributions within one percentage point and monotonic stickiness", (t) => {
  const low = makeFlag(10);
  const high = makeFlag(50, { version: 2 });
  const matched = makeFlag(0);
  matched.rules.rules = [makeRule("rule_rollout", 50)];
  const total = 100_000;
  let lowCount = 0;
  let highCount = 0;
  for (let i = 0; i < total; i += 1) {
    const user = { id: `distribution-${i}`, attributes: { plan: "pro" } };
    const at10 = evaluateFlag(low, user, null);
    const at50 = evaluateFlag(high, user, null);
    assert.equal(typeof at10, "boolean");
    assert.equal(typeof at50, "boolean");
    assert.equal(evaluateFlag(low, { ...user, attributes: {} }, null), at10);
    assert.equal(evaluateFlag(matched, user, null), at50, "rule IDs do not change the bucket");
    assert.ok(at10 !== true || at50 === true, `user ${i} lost access during an increase`);
    const slot = bucket(low.key, user.id);
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < 10000);
    if (at10 === true) lowCount += 1;
    if (at50 === true) highCount += 1;
  }
  const lowPercent = (lowCount / total) * 100;
  const highPercent = (highCount / total) * 100;
  assert.ok(Math.abs(lowPercent - 10) <= 1, `${lowPercent}% vs 10%`);
  assert.ok(Math.abs(highPercent - 50) <= 1, `${highPercent}% vs 50%`);
  t.diagnostic(
    `10%: ${lowCount}/${total} (${lowPercent.toFixed(3)}%); 50%: ${highCount}/${total} (${highPercent.toFixed(3)}%)`,
  );
});
