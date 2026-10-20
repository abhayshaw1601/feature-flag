import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuleSet } from "@flagforge/contracts";
import type { AiConfig } from "../lib/ai/config";
import type { AiTransport, GeminiRequest } from "../lib/ai/gemini";
import type { AiRunStore, RunCompletion, RunReservation } from "../lib/ai/runner";
import { sanitizeAiText } from "../lib/ai/sanitize";
import { buildAuditDigest, renderAuditMarkdown } from "../lib/audit/digest";
import { generateAuditSummaries } from "../lib/audit/generate";
import { classifyAuditRisk, normalizeAuditRow, summaryCandidates } from "../lib/audit/summaries";
import { auditDigestSchema, type AuditRow } from "../lib/audit/types";
import { auditSummaryV1 } from "../prompts/audit-summary.v1";

const NOW = "2026-10-20T12:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const time = (offset: number) => new Date(Date.parse(NOW) + offset).toISOString();

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "event-1",
    projectId: "project-1",
    projectName: "Checkout",
    flagId: "flag-1",
    flagKey: "checkout_v2",
    environmentId: "env-prod",
    environmentName: "Production",
    environmentKey: "production",
    actor: { id: "actor-1", name: "Priya" },
    actorName: null,
    action: "ENVIRONMENT_UPDATED",
    before: { enabled: true, rolloutPercent: 10 },
    after: { enabled: true, rolloutPercent: 50 },
    summary: "Unverified cached text",
    summarySource: "ai",
    summaryModel: "gemini-old",
    risky: false,
    createdAt: NOW,
    ...overrides,
  };
}

function rules(defaultPercent: number, targetedPercent?: number, value = "pro"): RuleSet {
  return {
    defaultServe: { rolloutPercent: defaultPercent },
    rules:
      targetedPercent === undefined
        ? []
        : [
            {
              id: "rule_plan",
              description: "Plan audience",
              conditions: [{ attribute: "plan", operator: "equals", values: [value] }],
              serve: { rolloutPercent: targetedPercent },
            },
          ],
  };
}

function assertCandidates(event: AuditRow, pattern: RegExp) {
  const candidates = summaryCandidates(event);
  assert.ok(candidates.length >= 2 && candidates.length <= 3);
  assert.equal(new Set(candidates).size, candidates.length);
  for (const candidate of candidates) {
    assert.match(candidate, pattern);
    assert.equal(sanitizeAiText(candidate), candidate);
    assert.ok(candidate.length <= 2000);
  }
  return candidates;
}

test("canonical sentences ground old/new default rollout and both enabled states", () => {
  assertCandidates(row(), /default rollout increased from 10% to 50%/);
  assertCandidates(
    row({ before: { rolloutPercent: 80 }, after: { rolloutPercent: 25 } }),
    /decreased from 80% to 25%/,
  );
  assertCandidates(
    row({ before: { enabled: false }, after: { enabled: true } }),
    /disabled to enabled/,
  );
  assertCandidates(
    row({ before: { enabled: true }, after: { enabled: false } }),
    /enabled to disabled/,
  );
  assertCandidates(
    row({
      before: { enabled: false, rolloutPercent: 10 },
      after: { enabled: true, rolloutPercent: 50 },
    }),
    /disabled to enabled; default rollout increased from 10% to 50%/,
  );
});

test("missing, invalid, unchanged or contradictory states never invent percentages or toggles", () => {
  const cases: Partial<AuditRow>[] = [
    { before: null },
    { after: null },
    { before: {} },
    { before: { enabled: false }, after: { rolloutPercent: 50 } },
    { before: { rolloutPercent: "10" }, after: { rolloutPercent: 50 } },
    { before: { rolloutPercent: -1 }, after: { rolloutPercent: 50 } },
    { before: { rolloutPercent: 10.5 }, after: { rolloutPercent: 50 } },
    { before: { rolloutPercent: 10 }, after: { rolloutPercent: 101 } },
    { before: { enabled: "false" }, after: { enabled: true } },
    { before: { rolloutPercent: 10 }, after: { rolloutPercent: 10 } },
    {
      before: { rolloutPercent: 10, rules: rules(0) },
      after: { rolloutPercent: 50, rules: rules(0) },
    },
    { before: { rules: { defaultServe: { rolloutPercent: 10 } } }, after: { rules: rules(50) } },
    { before: [10], after: [50] },
  ];
  for (const data of cases) {
    const event = row(data);
    const candidates = assertCandidates(event, /comparable change details/);
    assert.doesNotMatch(candidates.join(" "), /\d+%|disabled to enabled|enabled to disabled/);
    assert.equal(classifyAuditRisk(event), false);
  }
});

test("targeted rollout never becomes default or overall exposure", () => {
  const event = row({
    before: { enabled: true, rules: rules(0, 10) },
    after: { enabled: true, rules: rules(0, 90) },
  });
  const candidates = assertCandidates(event, /targeting rules changed/);
  assert.doesNotMatch(candidates.join(" "), /%|default rollout|all users/);
  assert.equal(classifyAuditRisk(event), true);
  assertCandidates(
    row({
      before: { rules: rules(10, 100) },
      after: { rules: rules(50, 100) },
    }),
    /default rollout increased from 10% to 50%/,
  );
  const malformed = rules(0, 10);
  malformed.rules[0].conditions = [];
  assertCandidates(
    row({ before: { rules: malformed }, after: { rules: rules(0, 90) } }),
    /comparable change details/,
  );
});

test("targeting comparisons retain exact raw values and do not emit audience data", () => {
  for (const [before, after] of [
    [rules(0, 10, "pro\u{1F680}"), rules(0, 10, "pro")],
    [rules(0, 10, "private audience"), rules(0, 10, "another private audience")],
  ]) {
    const event = row({ before: { rules: before }, after: { rules: after } });
    const snapshot = structuredClone(event);
    assertCandidates(event, /targeting rules changed/);
    const normalized = normalizeAuditRow(event);
    assert.equal(normalized.before, event.before);
    assert.equal(normalized.after, event.after);
    assert.deepEqual(event, snapshot);
    assert.doesNotMatch(normalized.summary, /private audience|pro/);
  }
  const before = rules(0, 10);
  const after = rules(0, 10);
  after.rules[0].conditions[0].attribute = " plan ";
  assertCandidates(
    row({ before: { rules: before }, after: { rules: after } }),
    /targeting rules changed/,
  );
});

test("targeted risk compares the same validated audience and rejects duplicate rule identities", () => {
  const event = row({
    environmentName: "Staging",
    environmentKey: "staging",
    before: { rules: rules(0, 10) },
    after: { rules: rules(0, 35) },
  });
  assert.equal(classifyAuditRisk(event), true);
  assert.equal(classifyAuditRisk({ ...event, after: { rules: rules(0, 34) } }), false);
  assert.equal(
    classifyAuditRisk({ ...event, after: { rules: rules(0, 90, "different audience") } }),
    false,
  );
  const duplicate = rules(0, 10);
  duplicate.rules.push({ ...duplicate.rules[0] });
  assert.equal(classifyAuditRisk({ ...event, before: { rules: duplicate } }), false);
  assertCandidates({ ...event, before: { rules: duplicate } }, /comparable change details/);
});

test("lifecycle actions and unknown identities have factual generic summaries", () => {
  for (const [action, verb] of [
    ["FLAG_CREATED", "created"],
    ["FLAG_ARCHIVED", "archived"],
    ["FLAG_RESTORED", "restored"],
    ["SDK_KEY_CREATED", "created"],
    ["SDK_KEY_REVOKED", "revoked"],
  ]) {
    const event = row({
      action,
      before: null,
      after: null,
      actor: null,
      actorName: null,
      flagKey: null,
    });
    const candidates = assertCandidates(event, /unknown actor/);
    assert.match(candidates[0], new RegExp(verb));
    assert.match(candidates[0], /an unidentified flag|an SDK key/);
    assert.doesNotMatch(candidates.join(" "), /%/);
  }
  assertCandidates(
    row({ action: "EXPERIMENT_UPDATED", before: null, after: null }),
    /change details/,
  );
  assertCandidates(row({ action: "__proto__" }), /change details/);
  assertCandidates(
    row({ actor: null, actorName: "FlagForge Guard", action: "AUTO_ROLLBACK" }),
    /FlagForge Guard/,
  );
  assertCandidates(
    row({ environmentName: null, environmentKey: null }),
    /unidentified environment/,
  );
  assertCandidates(row({ flagId: null, flagKey: null }), /the environment configuration/);
});

test("normalization accepts only canonical cached prose and resets invalid provenance", () => {
  const event = row();
  const summary = summaryCandidates(event)[1];
  const valid = normalizeAuditRow({ ...event, summary });
  assert.equal(valid.summary, summary);
  assert.equal(valid.summarySource, "ai");
  assert.equal(valid.summaryModel, "gemini-old");
  assert.equal(valid.risky, true);
  for (const stored of [
    "Priya raised checkout_v2 to 100%.",
    `${summary} \u{1F680}`,
    "<script>private</script>",
    "",
  ]) {
    const normalized = normalizeAuditRow({ ...event, summary: stored });
    assert.equal(normalized.summary, summaryCandidates(event)[0]);
    assert.equal(normalized.summarySource, "fallback");
    assert.equal(normalized.summaryModel, null);
  }
  const changed = normalizeAuditRow({ ...valid, after: { rolloutPercent: 60 } });
  assert.equal(changed.summarySource, "fallback");
  assert.match(changed.summary, /60%/);
  const harmless = normalizeAuditRow(row({ before: null, after: null, risky: true }));
  assert.equal(harmless.risky, false);
});

test("labels remove emoji/control text without renaming raw identifiers or retaining credentials", () => {
  const event = row({
    actor: { id: "actor\u{1F680}", name: "Priya\u{1F680}\n" },
    environmentName: "Production\u202e\u{1F680}",
    flagKey: "checkout_\u{1F680}v2",
    before: { rolloutPercent: 10, secret: "never emit this" },
  });
  const normalized = normalizeAuditRow(event);
  assert.match(normalized.summary, /^Priya updated an unidentified flag in Production:/);
  assert.equal(normalized.actor, event.actor);
  assert.equal(normalized.flagKey, event.flagKey);
  assert.equal(normalized.before, event.before);
  assert.doesNotMatch(normalized.summary, /never emit|\p{Extended_Pictographic}|\p{Cf}/u);
  for (const name of [
    "Bearer private-value",
    "ghp_privatevalue",
    "ff_server_privatevalue",
    "api_key=privatevalue",
    "A".repeat(161),
  ])
    assertCandidates(row({ actor: { id: "a", name } }), /unknown actor/);
});

test("risk uses bounded numeric changes and production aliases, including regional aliases", () => {
  assert.equal(classifyAuditRisk(row({ after: { rolloutPercent: 34 } })), false);
  assert.equal(classifyAuditRisk(row({ after: { rolloutPercent: 35 } })), true);
  assert.equal(
    classifyAuditRisk(row({ before: { rolloutPercent: 50 }, after: { rolloutPercent: 10 } })),
    false,
  );
  for (const alias of [
    "prod",
    "PRODUCTION",
    "prd",
    "live",
    "eu-prod",
    "production_us",
    "EU Live",
  ]) {
    for (const field of ["environmentName", "environmentKey"] as const) {
      const event = row({
        environmentName: "staging",
        environmentKey: "staging",
        [field]: alias,
        before: { enabled: false },
        after: { enabled: true },
      });
      assert.equal(classifyAuditRisk(event), true, `${field}: ${alias}`);
      assert.equal(classifyAuditRisk({ ...event, before: {} }), false);
    }
  }
  for (const alias of [
    "staging",
    "non-prod",
    "nonproduction",
    "pre-prod",
    "Non Production",
    "product",
    "delivery",
    "preview",
  ]) {
    assert.equal(
      classifyAuditRisk(
        row({
          environmentName: alias,
          environmentKey: alias,
          before: { enabled: false },
          after: { enabled: true },
        }),
      ),
      false,
      alias,
    );
  }
  assert.equal(classifyAuditRisk(row({ action: "FLAG_CREATED" })), false);
  assert.equal(
    classifyAuditRisk(row({ action: "SDK_KEY_REVOKED", before: null, after: null })),
    true,
  );
});

for (const days of [1, 7]) {
  test(`${days === 1 ? "24h" : "7d"} digest includes both exact bounds and excludes adjacent milliseconds`, () => {
    const from = time(-days * DAY);
    const events = [
      row({ id: "start", createdAt: from }),
      row({ id: "end", createdAt: NOW }),
      row({ id: "before", createdAt: time(-days * DAY - 1) }),
      row({ id: "after", createdAt: time(1) }),
    ];
    const digest = buildAuditDigest(events, { from, to: NOW });
    assert.deepEqual(
      digest.groups.flatMap((group) => group.items.map((item) => item.eventId)),
      ["end", "start"],
    );
    assert.equal(digest.eventCount, 2);
    assert.equal(digest.truncated, false);
    assert.equal(digest.totalCount, 2);
    assert.ok(auditDigestSchema.safeParse(digest).success);
  });
}

test("digests deduplicate, group by IDs, and order risky groups/items then newest with stable ties", () => {
  const events = [
    row({ id: "safe-new", projectId: "other", before: null }),
    row({ id: "risk-old", createdAt: time(-DAY + 1) }),
    row({ id: "risk-b", createdAt: time(-1000) }),
    row({ id: "risk-a", createdAt: time(-1000) }),
    row({ id: "safe-item", before: null }),
    row({ id: "same-name-new-env", environmentId: "another-env", before: null }),
  ];
  const digest = buildAuditDigest([...events, events[1], events[2]], { from: time(-DAY), to: NOW });
  assert.equal(digest.eventCount, events.length);
  assert.equal(digest.groups.length, 3);
  assert.equal(digest.groups[0].projectId, "project-1");
  assert.equal(digest.groups[0].environmentId, "env-prod");
  assert.equal(digest.groups[0].risky, true);
  assert.deepEqual(
    digest.groups[0].items.map((item) => item.eventId),
    ["risk-a", "risk-b", "risk-old", "safe-item"],
  );
  assert.deepEqual(buildAuditDigest([...events].reverse(), { from: time(-DAY), to: NOW }), digest);
  for (const group of digest.groups)
    for (const item of group.items) {
      const source = events.find((event) => event.id === item.eventId)!;
      assert.ok(summaryCandidates(source).includes(item.summary));
    }
});

test("group newest time includes safe items even when an older risky item is first", () => {
  const digest = buildAuditDigest(
    [
      row({ id: "a-risk-old", projectId: "a", createdAt: time(-10000) }),
      row({ id: "a-safe-new", projectId: "a", before: null }),
      row({ id: "b-risk-middle", projectId: "b", createdAt: time(-1000) }),
    ],
    { from: time(-DAY), to: NOW },
  );
  assert.deepEqual(
    digest.groups.map((group) => group.projectId),
    ["a", "b"],
  );
});

test("digest keeps selected canonical cache, reports truncation, and preserves caller-filtered scope", () => {
  const selected = row({ actor: { id: "chosen", name: "Priya" } });
  selected.summary = summaryCandidates(selected)[1];
  const all = [selected, row({ id: "other-actor", actor: { id: "other", name: "Other" } })];
  const filtered = all.filter((event) => event.actor?.id === "chosen");
  const digest = buildAuditDigest([...filtered, selected], {
    from: time(-DAY),
    to: NOW,
    totalCount: 8,
  });
  assert.equal(digest.groups[0].items[0].summary, selected.summary);
  assert.equal(digest.eventCount, 1);
  assert.equal(digest.totalCount, 8);
  assert.equal(digest.truncated, true);
  assert.match(digest.markdown, /Truncated:.*additional matching events are not shown/);
  assert.doesNotMatch(digest.markdown, /other-actor/);
  const empty = buildAuditDigest([], { from: time(-DAY), to: NOW, totalCount: 2 });
  assert.equal(empty.truncated, true);
  assert.match(empty.markdown, /No audit events/);
  assert.equal(buildAuditDigest([row()], { from: NOW, to: NOW, totalCount: 0 }).totalCount, 1);
  assert.throws(() => buildAuditDigest([], { from: NOW, to: time(-1) }), RangeError);
  assert.throws(() => buildAuditDigest([], { from: "not a date", to: NOW }));
  assert.throws(() => buildAuditDigest([], { from: NOW, to: NOW, totalCount: -1 }), RangeError);
});

test("Markdown export escapes headings, HTML, links, entities, controls and inline formatting", () => {
  const hostile =
    "\n# Forged [click](https://evil.invalid) <img src=x> &lt;script&gt; `code` | **bold** \\!";
  const event = row({
    id: "event-[bad](https://evil.invalid)\n# Fake",
    actor: { id: "actor", name: hostile },
    projectName: hostile,
    environmentName: hostile,
    before: { rolloutPercent: 10, token: "raw-private-secret" },
    after: { rolloutPercent: 50, arbitrary: "raw-private-secret" },
  });
  const digest = buildAuditDigest([event], { from: time(-DAY), to: NOW, totalCount: 2 });
  assert.equal(digest.groups[0].items[0].eventId, event.id);
  assert.equal(digest.markdown, renderAuditMarkdown(digest));
  assert.equal(digest.markdown.split("\n").filter((line) => line.startsWith("# ")).length, 1);
  assert.equal(digest.markdown.split("\n").filter((line) => line.startsWith("## ")).length, 1);
  assert.doesNotMatch(
    digest.markdown,
    /<img|https:\/\/|\[click\]|\*\*bold\*\*|`code`|raw-private-secret|\n# Fake|\n# Forged|&lt;/,
  );
  assert.match(digest.markdown, /&#35; Forged/);
  assert.match(digest.markdown, /&#60;img/);
  assert.match(digest.markdown, /Event ID: event&#45;&#91;bad&#93;/);
  assert.match(digest.markdown, /Time range \(inclusive\):/);
  assert.match(digest.markdown, /Risk flagged/);
});

const config: AiConfig = {
  mock: false,
  models: { fast: "gemini-fast-test", reasoning: "gemini-reasoning-test" },
  dailyWorkspaceCallLimit: 17,
  timeoutMs: 30000,
};
const context = { workspaceId: "workspace-1", userId: "user-1" };

function fakeRun(responses: unknown[] = []) {
  const calls: GeminiRequest[] = [];
  const reserved: RunReservation[] = [];
  const finished: RunCompletion[] = [];
  const transport: AiTransport = {
    async generate(request) {
      calls.push(request);
      assert.ok(responses.length, "Unexpected provider call");
      return { text: JSON.stringify(responses.shift()), tokensIn: 4, tokensOut: 3 };
    },
    async *stream() {
      assert.fail("Unexpected streaming call");
      yield { text: "", tokensIn: 0, tokensOut: 0 };
    },
  };
  const store: AiRunStore = {
    async reserve(input) {
      reserved.push(input);
      return "run-audit";
    },
    async finish(id, result) {
      assert.equal(id, "run-audit");
      finished.push(result);
    },
  };
  return { calls, reserved, finished, transport, store };
}

const output = (events: AuditRow[]) => ({
  summaries: events.map((event) => ({ eventId: event.id, summary: summaryCandidates(event)[1] })),
});

test("shared runner uses actual configured fast model, minimal allowlist and safe metadata", async () => {
  const events = [
    row({
      before: {
        rolloutPercent: 10,
        secret: "raw-private-secret",
        targeting: { email: "person@example.invalid" },
      },
      after: { rolloutPercent: 50, sdkKey: "ff_server_privatevalue" },
      summary: "cached-injection-private",
    }),
  ];
  const state = fakeRun([output(events)]);
  const controller = new AbortController();
  const result = await generateAuditSummaries(events, {
    context,
    config,
    ...state,
    signal: controller.signal,
  });
  assert.deepEqual(result.output, output(events));
  assert.equal(result.model, config.models.fast);
  assert.equal(result.runId, "run-audit");
  assert.equal(result.mock, false);
  assert.equal(result.promptVersion, "1");
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].model, config.models.fast);
  assert.equal(state.calls[0].signal, controller.signal);
  assert.equal(state.reserved[0].feature, "AUDIT_SUMMARY");
  assert.equal(state.reserved[0].dailyLimit, 17);
  assert.deepEqual(state.reserved[0].input, {
    metadata: { eventIds: ["event-1"], count: 1, projectIds: ["project-1"] },
    promptId: "audit-summary",
    promptVersion: "1",
    mock: false,
  });
  const input = JSON.parse(state.calls[0].user.split("\n")[1]);
  assert.deepEqual(input, {
    events: [{ eventId: events[0].id, candidates: summaryCandidates(events[0]) }],
  });
  assert.doesNotMatch(
    JSON.stringify([state.calls, state.reserved, state.finished]),
    /raw-private-secret|person@example|ff_server_privatevalue|cached-injection-private/,
  );
  assert.equal(state.finished[0].status, "SUCCEEDED");
  assert.equal(state.finished[0].tokensIn, 4);
  assert.ok(state.calls[0].jsonSchema);
  assert.equal(auditSummaryV1.tier, "fast");
  assert.equal(auditSummaryV1.schema.safeParse(output(events)).success, true);
});

test("mock fixtures use every actual row, pass dynamic schema, log a real logical run and make no transport call", async () => {
  const events = Array.from({ length: 20 }, (_, index) =>
    row({
      id: `actual-event-${index}`,
      before: { rolloutPercent: index },
      after: { rolloutPercent: index + 1 },
    }),
  );
  const state = fakeRun();
  const result = await generateAuditSummaries(events, {
    context,
    config: { ...config, mock: true },
    ...state,
  });
  assert.equal(result.mock, true);
  assert.equal(result.model, config.models.fast);
  assert.equal(result.tokensIn, 0);
  assert.equal(state.calls.length, 0);
  assert.equal(state.reserved.length, 1);
  assert.equal(state.finished.length, 1);
  assert.deepEqual(
    result.output.summaries,
    events.map((event) => ({ eventId: event.id, summary: summaryCandidates(event)[0] })),
  );
  assert.deepEqual(state.finished[0].output, result.output);
});

for (const invalid of [
  "wrong ID",
  "duplicate ID",
  "missing ID",
  "extra ID",
  "invented summary",
  "swapped summary",
  "extra wrapper key",
  "extra item key",
]) {
  test(`${invalid} is rejected and corrected by the shared runner's one retry`, async () => {
    const events = [row(), row({ id: "event-2", after: { rolloutPercent: 60 } })];
    const valid = output(events);
    const bad: {
      summaries: Array<{ eventId: string; summary: string; invented?: boolean }>;
      invented?: boolean;
    } = structuredClone(valid);
    if (invalid === "wrong ID") bad.summaries[0].eventId = "not-requested";
    if (invalid === "duplicate ID") bad.summaries[1] = { ...bad.summaries[0] };
    if (invalid === "missing ID") bad.summaries.pop();
    if (invalid === "extra ID")
      bad.summaries.push({ eventId: "not-requested", summary: "Unknown" });
    if (invalid === "invented summary")
      bad.summaries[0].summary = "Priya raised made_up_flag to 100%.";
    if (invalid === "swapped summary")
      [bad.summaries[0].summary, bad.summaries[1].summary] = [
        bad.summaries[1].summary,
        bad.summaries[0].summary,
      ];
    if (invalid === "extra wrapper key") bad.invented = true;
    if (invalid === "extra item key") bad.summaries[0].invented = true;
    const state = fakeRun([bad, valid]);
    const result = await generateAuditSummaries(events, { context, config, ...state });
    assert.deepEqual(result.output, valid);
    assert.equal(state.calls.length, 2);
    assert.match(state.calls[1].user, /previous output failed validation/);
    assert.doesNotMatch(state.calls[1].user, /made_up_flag|not-requested/);
    assert.equal(state.reserved.length, 1);
    assert.equal(state.finished.length, 1);
    assert.equal(result.tokensIn, 8);
    assert.equal(result.tokensOut, 6);
  });
}

test("two invented responses fail closed and record only the shared safe failure", async () => {
  const bad = { summaries: [{ eventId: "event-1", summary: "private-invented-output" }] };
  const state = fakeRun([bad, bad]);
  await assert.rejects(generateAuditSummaries([row()], { context, config, ...state }), {
    code: "AI_INVALID_OUTPUT",
  });
  assert.equal(state.calls.length, 2);
  assert.equal(state.finished[0].status, "FAILED");
  assert.equal(state.finished[0].error, "AI_INVALID_OUTPUT");
  assert.doesNotMatch(JSON.stringify(state.finished), /private-invented-output/);
});

test("batch validation rejects empty, oversized, duplicate or sanitizer-unstable IDs before reservation", async () => {
  for (const events of [
    [],
    Array.from({ length: 21 }, (_, index) => row({ id: `event-${index}` })),
    [row(), row()],
    [row({ id: "event\u{1F680}" })],
  ]) {
    const state = fakeRun();
    await assert.rejects(generateAuditSummaries(events, { context, config, ...state }), {
      code: "AI_INVALID_INPUT",
    });
    assert.equal(state.reserved.length, 0);
    assert.equal(state.calls.length, 0);
  }
});

test("cancellation and admission denial stay owned by the shared runner, including mock mode", async () => {
  const controller = new AbortController();
  controller.abort();
  const state = fakeRun();
  await assert.rejects(
    generateAuditSummaries([row()], { context, config, ...state, signal: controller.signal }),
    { code: "AI_CANCELLED" },
  );
  assert.equal(state.calls.length, 0);
  assert.equal(state.finished[0].status, "FAILED");
  const store: AiRunStore = {
    async reserve() {
      throw new Error("admission denied");
    },
    async finish() {
      assert.fail("Denied runs must not be finished");
    },
  };
  await assert.rejects(
    generateAuditSummaries([row()], {
      context,
      config: { ...config, mock: true },
      store,
      transport: state.transport,
    }),
    /admission denied/,
  );
  assert.equal(state.calls.length, 0);
});
