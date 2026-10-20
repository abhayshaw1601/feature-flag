# @flagforge/evaluator

Version 0.1.0. Pure TypeScript local evaluation for Node and browsers, with zero
runtime dependencies or I/O. Structural types mirror `packages/contracts/src`
without importing its runtime validators. Flag `type` is a purpose/category,
not a restriction on the JSON value returned.

## Public API

- `murmur3(input: string): number`: unsigned MurmurHash3 x86_32, seed 0, UTF-8.
  Unpaired UTF-16 surrogates become U+FFFD, as with `TextEncoder`. No Unicode
  normalization is applied.
- `bucket(flagKey: string, userId: string): number`: exactly
  `murmur3(flagKey + ":" + userId) % 10000`, in `[0, 9999]`.
- `matchesCondition(condition: Condition, user: EvaluationUser): boolean`.
- `evaluateFlag(flag, user, fallback: JsonValue): JsonValue`.
- `evaluateDetailed(flag, user, fallback): EvaluationResult`: returns
  `{ value, variation: "on" | "off" | "fallback", reason, ruleId? }`.

`flag` is `ServerFlagConfig | null | undefined`; `user` is
`EvaluationUser | null | undefined`. Exported types also include `JsonScalar`,
`JsonValue`, `FlagType`, `RuleOperator`, `Condition`, `Serve`, `Rule`, `RuleSet`,
`EvaluationUser`, `ServerFlagConfig`, `EvaluationReason`, and `EvaluationResult`.

## Semantics

- Validate the entire config before evaluation. Malformed metadata, rules,
  percentages, or either JSON value return the exact caller fallback with
  `variation: "fallback", reason: "invalid_config"`. Contract limits apply:
  integer percentages 0–100, up to 50 rules, 1–20 conditions per rule, and
  1–50 scalar operands per condition. Sparse arrays, cycles, accessors, and
  non-JSON values are invalid. Fallback itself must be caller-supplied JSON.
- A valid disabled config always returns `offValue` with `reason: "disabled"`,
  even without valid user context. Enabled configs require a nonempty string
  user ID and a plain/null-prototype attributes record of finite JSON scalars; otherwise they return
  the fallback with `reason: "invalid_context"`.
- Conditions within a rule are ANDed. The first matching rule is decisive,
  including when its rollout serves off (`reason: "rule_match"`, with `ruleId`).
  If no rule matches, use `defaultServe` (`reason: "default"`, no `ruleId`).
- Serve on exactly when `bucket < rolloutPercent * 100`; otherwise serve off.
  Raising the percentage retains all previously enabled users for a fixed flag
  key and user ID. Versions, attributes, and rule IDs do not seed the bucket.
- `equals` and `in` mean strict equality with **any** operand; `not_equals` and
  `not_in` require strict inequality with **every** operand. No type coercion.
  `null`, `false`, `0`, and `""` are present values, not missing values.
- `contains` / `starts_with` are case-sensitive string-only operations.
  `greater_than` / `less_than` accept finite numbers only and are exclusive.
  Each of these operators matches **any** correctly typed operand; operands of
  another scalar type do not match. Invalid conditions return false directly
  and invalidate an enclosing flag config.
- Attributes are literal keys in `user.attributes`; no dotted-path traversal,
  implicit `user.id` lookup, or prototype lookup occurs. Only own enumerable
  data properties count. Missing attributes match **no** operator, including
  negations. Own JSON keys such as `constructor` and `__proto__` are ordinary
  data; inherited keys are ignored, and custom-prototype records are invalid.
  Getters are never deliberately invoked.
- Inputs are not mutated or cached. Returned JSON objects/arrays retain their
  identity; treat them as read-only. Variation describes the selected branch,
  even when on/off values are identical or falsy.

## Build, test, benchmark

Use the repository's pinned Node version (`.nvmrc`) and existing lockfile/local
TypeScript and tsx tools. From the repository root, after its normal `npm ci`:

```sh
./node_modules/.bin/tsc -p packages/evaluator/tsconfig.json
./node_modules/.bin/tsx --test tests/evaluator.test.ts
./node_modules/.bin/tsx scripts/benchmark-evaluator.ts
```

These commands need no network after dependencies are installed. The standalone
tsconfig includes only package sources and no Node or DOM type libraries.
The benchmark warms up first, times at least 100,000 local evaluations per
sample with `node:perf_hooks`, and prints batch-average timings and counts.
It measures this process/workload, not delivery latency or a production SLA.

The ESM entry point and declarations are `dist/index.js` and `dist/index.d.ts`.
Build before publishing/consuming the package (`npm pack ./packages/evaluator`
from the repository root). Consumers import from `@flagforge/evaluator`;
TypeScript-aware repo tools can opt into the `development` export condition to
load `src/index.ts`. Tests and the benchmark use relative source imports so they
also work before workspace registration or package installation.
