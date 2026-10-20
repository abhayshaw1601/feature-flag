import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlagEnvironmentConfig, FlagSummary, Rule } from "@flagforge/contracts";
import { scanRepository, type RepositoryFile, type ScannedReference } from "../lib/cleanup/scanner";
import { findStaleCandidates } from "../lib/cleanup/stale";

const day = 86_400_000;
const now = new Date("2026-10-20T12:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * day).toISOString();
const environmentKeys = ["development", "staging", "production"] as const;
const options = { now, environmentKeys };

function environment(
  environmentKey: string,
  overrides: Partial<FlagEnvironmentConfig> = {},
): FlagEnvironmentConfig {
  return {
    environmentId: `env_${environmentKey}`,
    environmentKey,
    enabled: true,
    rules: { defaultServe: { rolloutPercent: 100 }, rules: [] },
    rolloutPercent: 100,
    offValue: false,
    onValue: true,
    version: 2,
    updatedAt: ago(90),
    ...overrides,
  };
}

function flag(overrides: Partial<FlagSummary> = {}): FlagSummary {
  return {
    id: "flag_checkout",
    projectId: "project_store",
    key: "checkout_refresh",
    name: "Checkout refresh",
    description: null,
    type: "RELEASE",
    tags: [],
    owner: null,
    archivedAt: null,
    createdAt: ago(120),
    updatedAt: ago(90),
    environments: environmentKeys.map((key) => environment(key)),
    ...overrides,
  };
}

function rule(rolloutPercent: number): Rule {
  return {
    id: "rule_internal",
    description: "Internal accounts",
    conditions: [{ attribute: "plan", operator: "equals", values: ["internal"] }],
    serve: { rolloutPercent },
  };
}

const references: ScannedReference[] = [
  {
    flagKey: "checkout_refresh",
    filePath: "src/checkout.ts",
    line: 3,
    snippet: 'const checkout = sdk.isEnabled("checkout_refresh");',
  },
];

function scan(content: string, filePath = "src/checkout.ts") {
  return scanRepository([{ filePath, content }], ["checkout_refresh", "search_layout"]);
}

test("scanner finds known direct/member/optional calls and preserves file/source order", () => {
  const files: RepositoryFile[] = [
    {
      filePath: "src/checkout.ts",
      content: [
        'const enabled = sdk.isEnabled("checkout_refresh");',
        "const search = getValue('search_layout', user, 'old');",
        'sdk?.isEnabled?.("checkout_refresh"); isEnabled("unknown");',
        'const choice = ready ? isEnabled("checkout_refresh") : false;',
        'const weight = 2 * isEnabled("checkout_refresh");',
      ].join("\n"),
    },
    { filePath: "src/next.js", content: 'client.getValue("search_layout");' },
  ];
  const snapshot = structuredClone(files);
  const found = scanRepository(files, ["checkout_refresh", "search_layout", "checkout_refresh"]);
  assert.deepEqual(
    found.map(({ flagKey, line, filePath }) => [flagKey, line, filePath]),
    [
      ["checkout_refresh", 1, "src/checkout.ts"],
      ["search_layout", 2, "src/checkout.ts"],
      ["checkout_refresh", 3, "src/checkout.ts"],
      ["checkout_refresh", 4, "src/checkout.ts"],
      ["checkout_refresh", 5, "src/checkout.ts"],
      ["search_layout", 1, "src/next.js"],
    ],
  );
  assert.deepEqual(files, snapshot);
  assert.deepEqual(scanRepository(files, []), []);
  assert.deepEqual(scanRepository([], ["checkout_refresh"]), []);
});

test("scanner handles multiline comments, nested generic types and useful surrounding code", () => {
  const content = [
    "const before = user.id;",
    "const layout = sdk",
    "  .getValue<",
    "    Record<string, { nested: Array<string>; load: () => boolean }>",
    "  > /* first argument follows */ (",
    '    "search_layout",',
    "    user,",
    "    { nested: [], load: () => true },",
    "  );",
    "render(layout);",
    "isEnabled /* trailing comment */ ( 'checkout_refresh' );",
  ].join("\r\n");
  const found = scan(content);
  assert.deepEqual(
    found.map(({ flagKey, line }) => [flagKey, line]),
    [
      ["search_layout", 3],
      ["checkout_refresh", 11],
    ],
  );
  assert.match(found[0].snippet, /const layout = sdk/);
  assert.match(found[0].snippet, /"search_layout"/);
  assert.match(found[0].snippet, /render\(layout\)/);
  assert.equal(scan('/* first\rsecond\r*/\risEnabled("checkout_refresh");')[0].line, 4);
});

test("scanner excludes comments, quoted text, templates and regex literals", () => {
  const source = [
    '// isEnabled("checkout_refresh")',
    '/* sdk.getValue("search_layout") */',
    "const example = 'sdk.isEnabled(\"checkout_refresh\")';",
    "const other = \"getValue('search_layout')\";",
    String.raw`const escaped = "say \"isEnabled('checkout_refresh')\"";`,
    'const template = `isEnabled("checkout_refresh") ${getValue("search_layout")}`;',
    'const nested = `outer ${`inner ${isEnabled("checkout_refresh")}`} text`;',
    'const pattern = /isEnabled("checkout_refresh")/g;',
    'if (ready) /getValue("search_layout")/.test(text);',
    'function patternFactory() { return /getValue("search_layout")/; }',
    'sdk.isEnabled("checkout_refresh");',
  ].join("\n");
  const found = scan(source);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 11);
});

test("scanner excludes dynamic arguments, aliases, computed members and definitions", () => {
  const source = [
    'const key = "checkout_refresh"; sdk.isEnabled(key);',
    'sdk.isEnabled("checkout_refresh" + suffix);',
    'getValue("search_layout" || fallback);',
    "getValue(`search_layout`);",
    'getValue("search_layout" as string);',
    'sdk["isEnabled"]("checkout_refresh");',
    'const enabled = sdk.isEnabled; enabled("checkout_refresh");',
    'new isEnabled("checkout_refresh"); new sdk.getValue("search_layout");',
    'function isEnabled(key = "checkout_refresh") { return key; }',
    'function* getValue(key = "search_layout") { yield key; }',
    'declare function getValue<T>(key: "search_layout"): T;',
    'interface Client { isEnabled(key: "checkout_refresh"): boolean; }',
    'const client = { getValue(key = "search_layout") { return key; } };',
    'class Client { isEnabled(key = "checkout_refresh") { return true; } }',
    'sdk.isEnabled("checkout_\\u0072efresh");',
    'unrelated_isEnabled("checkout_refresh"); übersisEnabled("checkout_refresh");',
    'sdk.isEnabled("unknown");',
  ].join("\n");
  assert.deepEqual(scan(source), []);
});

test("scanner treats JSX text/attributes as data and scans JSX expressions", () => {
  const found = scan(
    [
      'const outside = getValue<boolean>("checkout_refresh");',
      "const panel = <section title={'getValue(\"search_layout\")'}>",
      '  isEnabled("checkout_refresh")',
      "  <span title=\"isEnabled('checkout_refresh')\" />",
      '  {sdk.isEnabled("checkout_refresh") ? <b>On</b> : null}',
      '  <Panel value={getValue<string>("search_layout")} />',
      "</section>;",
    ].join("\n"),
    "src/panel.tsx",
  );
  assert.deepEqual(
    found.map(({ flagKey, line }) => [flagKey, line]),
    [
      ["checkout_refresh", 1],
      ["checkout_refresh", 5],
      ["search_layout", 6],
    ],
  );
});

test("scanner supports JS/TS extensions and excludes build/vendor/lock/declaration paths", () => {
  const content = 'sdk.isEnabled("checkout_refresh");';
  const included = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"].map(
    (extension) => `src/file.${extension}`,
  );
  included.push("src\\windows.ts", "src/rebuild/main.ts");
  const excluded = [
    "node_modules/sdk/index.ts",
    "node_modules.partial-backup/sdk/index.js",
    "src/vendor/client.js",
    "bower_components/sdk.js",
    "dist/main.js",
    "build/main.ts",
    "out/main.js",
    "coverage/main.js",
    ".next/server/main.js",
    ".git/hooks/check.js",
    ".nuxt/main.js",
    ".output/main.js",
    "src/__generated__/client.ts",
    "src/generated/client.ts",
    "src/client.generated.ts",
    "src/client.min.js",
    "src/types.d.ts",
    "src/types.d.mts",
    "src\\NODE_MODULES\\client.ts",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "generated.lock.js",
    "src/code.py",
    "src/code.rb",
    "src/code.go",
    "README.md",
    "src/view.vue",
    "src/template.html",
    "src/code.ts.map",
  ];
  const found = scanRepository(
    [...included, ...excluded].map((filePath) => ({ filePath, content })),
    ["checkout_refresh"],
  );
  assert.deepEqual(
    found.map(({ filePath }) => filePath),
    included,
  );
});

test("scanner distinguishes regex data from ordinary division and ignores unfinished calls", () => {
  assert.equal(scan('const ratio = total / getValue("search_layout");').length, 1);
  assert.deepEqual(scan('isEnabled("checkout_refresh"'), []);
  assert.deepEqual(scan('/* isEnabled("checkout_refresh")'), []);
  assert.deepEqual(scan("\"isEnabled('checkout_refresh')"), []);
});

test("stale ON includes the exact 30-day boundary but not one millisecond before", () => {
  for (const [elapsed, expected] of [
    [30 * day - 1, 0],
    [30 * day, 1],
    [31 * day - 1, 1],
  ]) {
    const updatedAt = new Date(now.getTime() - elapsed).toISOString();
    const input = flag({
      environments: environmentKeys.map((key) => environment(key, { updatedAt })),
    });
    const found = findStaleCandidates([input], references, options);
    assert.equal(found.length, expected, `${elapsed}ms`);
    if (found.length) {
      assert.deepEqual(found[0], {
        flagId: input.id,
        flagKey: input.key,
        flagName: input.name,
        reason: "ON_EVERYWHERE",
        daysStale: 30,
        referenceCount: 1,
        references,
      });
    }
  }
});

test("stale OFF requires 60 days, even when inactive rollout/targeting would otherwise be ON", () => {
  for (const [elapsed, expected] of [
    [60 * day - 1, 0],
    [60 * day, 1],
    [61 * day - 1, 1],
  ]) {
    const input = flag({
      environments: environmentKeys.map((key) =>
        environment(key, {
          enabled: false,
          updatedAt: new Date(now.getTime() - elapsed).toISOString(),
          rules: { defaultServe: { rolloutPercent: 0 }, rules: [rule(50)] },
        }),
      ),
    });
    const found = findStaleCandidates([input], references, options);
    assert.equal(found.length, expected);
    if (found.length) {
      assert.equal(found[0].reason, "OFF_EVERYWHERE");
      assert.equal(found[0].daysStale, 60);
    }
  }
});

test("thresholds are independently configurable positive integers", () => {
  const onFlag = flag({ createdAt: ago(7) });
  const offFlag = flag({
    createdAt: ago(9),
    environments: environmentKeys.map((key) => environment(key, { enabled: false })),
  });
  assert.equal(findStaleCandidates([onFlag], references, { ...options, onDays: 7 }).length, 1);
  assert.equal(findStaleCandidates([onFlag], references, { ...options, onDays: 8 }).length, 0);
  assert.equal(findStaleCandidates([offFlag], references, { ...options, offDays: 9 }).length, 1);
  assert.equal(findStaleCandidates([offFlag], references, { ...options, offDays: 10 }).length, 0);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ["onDays", "offDays"]) {
      assert.throws(() => findStaleCandidates([], [], { ...options, [key]: invalid }), RangeError);
    }
  }
  assert.throws(() => findStaleCandidates([], [], { ...options, now: new Date(NaN) }), RangeError);
});

test("stale detection requires complete unique expected environment coverage", () => {
  const normal = flag();
  const cases = [
    [],
    normal.environments.slice(0, 2),
    [normal.environments[0], normal.environments[0], normal.environments[2]],
    [normal.environments[0], normal.environments[1], environment("preview")],
    [...normal.environments, environment("preview")],
    normal.environments.map((config) => ({ ...config, environmentId: "same_id" })),
  ];
  for (const environments of cases) {
    assert.deepEqual(findStaleCandidates([flag({ environments })], references, options), []);
  }
  for (const keys of [[], ["production", "production"], [""], [" production"], ["PRODUCTION"]]) {
    assert.deepEqual(findStaleCandidates([normal], references, { now, environmentKeys: keys }), []);
  }
  assert.equal(
    findStaleCandidates([normal], references, {
      now,
      environmentKeys: [...environmentKeys].reverse(),
    }).length,
    1,
  );
  assert.equal(
    findStaleCandidates([flag({ environments: [environment("production")] })], references, {
      now,
      environmentKeys: ["production"],
    }).length,
    1,
  );
});

test("ON guarantees require scalar, default and every targeting override at 100 percent", () => {
  const changes: Partial<FlagEnvironmentConfig>[] = [
    { enabled: false },
    { rolloutPercent: 99 },
    { rolloutPercent: 0 },
    { rules: { defaultServe: { rolloutPercent: 0 }, rules: [] } },
    { rules: { defaultServe: { rolloutPercent: 99 }, rules: [rule(100)] } },
    { rules: { defaultServe: { rolloutPercent: 100 }, rules: [rule(0)] } },
    { rules: { defaultServe: { rolloutPercent: 100 }, rules: [rule(100), rule(50)] } },
  ];
  for (const change of changes) {
    const input = flag();
    input.environments[2] = { ...input.environments[2], ...change };
    assert.deepEqual(findStaleCandidates([input], references, options), [], JSON.stringify(change));
  }
  const allOn = flag({
    environments: environmentKeys.map((key) =>
      environment(key, {
        rules: { defaultServe: { rolloutPercent: 100 }, rules: [rule(100)] },
      }),
    ),
  });
  assert.equal(findStaleCandidates([allOn], references, options).length, 1);
  const zeroButEnabled = flag({
    environments: environmentKeys.map((key) =>
      environment(key, {
        rolloutPercent: 0,
        rules: { defaultServe: { rolloutPercent: 0 }, rules: [] },
      }),
    ),
  });
  assert.deepEqual(findStaleCandidates([zeroButEnabled], references, options), []);
});

test("the latest configuration change and flag creation conservatively bound continuous age", () => {
  for (const index of [0, 1, 2]) {
    const input = flag();
    input.environments[index].updatedAt = ago(2);
    assert.deepEqual(findStaleCandidates([input], references, options), []);
  }
  assert.deepEqual(findStaleCandidates([flag({ createdAt: ago(1) })], references, options), []);
  const input = flag({ createdAt: ago(40), updatedAt: ago(1) });
  input.environments[0].updatedAt = ago(45);
  assert.equal(findStaleCandidates([input], references, options)[0].daysStale, 40);
  input.environments[1].updatedAt = ago(35.5);
  assert.equal(findStaleCandidates([input], references, options)[0].daysStale, 35);
});

test("invalid, normalized-invalid and future dates fail closed", () => {
  const invalidDates = [
    "not-a-date",
    "2026-02-30T00:00:00.000Z",
    "2026-02-28T24:00:00.000Z",
    "2026-01-01",
    "2026-01-01T00:00:00",
    new Date(now.getTime() + 1).toISOString(),
  ];
  for (const invalid of invalidDates) {
    for (const field of ["createdAt", "updatedAt"] as const) {
      assert.deepEqual(findStaleCandidates([flag({ [field]: invalid })], references, options), []);
    }
    const input = flag();
    input.environments[1].updatedAt = invalid;
    assert.deepEqual(findStaleCandidates([input], references, options), []);
  }
});

test("archived or unreferenced flags are excluded and references are grouped without mutation", () => {
  assert.deepEqual(findStaleCandidates([flag({ archivedAt: ago(1) })], references, options), []);
  assert.deepEqual(findStaleCandidates([flag()], [], options), []);
  assert.deepEqual(findStaleCandidates([], references, options), []);
  const input = [flag()];
  const refs = [
    references[0],
    { ...references[0], flagKey: "unrelated" },
    { ...references[0], filePath: "src/second.ts", line: 10 },
  ];
  const before = structuredClone({ input, refs, options });
  const found = findStaleCandidates(input, refs, options);
  assert.equal(found[0].referenceCount, 2);
  assert.deepEqual(found[0].references, [refs[0], refs[2]]);
  assert.notEqual(found[0].references, refs);
  assert.deepEqual({ input, refs, options }, before);
});

test("served values must agree structurally across every environment", () => {
  for (const enabled of [true, false]) {
    const input = flag({
      environments: environmentKeys.map((key) => environment(key, { enabled })),
    });
    const active = enabled ? "onValue" : "offValue";
    const inactive = enabled ? "offValue" : "onValue";
    input.environments[0][active] = { theme: "new", layout: [1, { dense: true }] };
    input.environments[1][active] = { layout: [1, { dense: true }], theme: "new" };
    input.environments[2][active] = { theme: "new", layout: [1, { dense: true }] };
    input.environments[1][inactive] = "unused and different";
    assert.equal(findStaleCandidates([input], references, options).length, 1);
    input.environments[2][active] = { theme: "new", layout: [{ dense: true }, 1] };
    assert.deepEqual(findStaleCandidates([input], references, options), []);
    input.environments[2][active] = null;
    assert.deepEqual(findStaleCandidates([input], references, options), []);
    for (const config of input.environments) config[active] = null;
    assert.equal(findStaleCandidates([input], references, options).length, 1);
    input.environments[2][active] = false;
    assert.deepEqual(findStaleCandidates([input], references, options), []);
  }
});

test("scanner output feeds stale detection with stable candidate order", () => {
  const flags = [flag(), flag({ id: "flag_search", key: "search_layout", name: "Search layout" })];
  const scanned = scan('getValue("search_layout"); sdk.isEnabled("checkout_refresh");');
  const found = findStaleCandidates(flags, scanned, options);
  assert.deepEqual(
    found.map(({ flagKey }) => flagKey),
    ["checkout_refresh", "search_layout"],
  );
  assert.deepEqual(
    found.map(({ referenceCount }) => referenceCount),
    [1, 1],
  );
});
