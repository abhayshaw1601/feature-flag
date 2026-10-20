import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  AI_TOOL_LIMITS,
  AiToolError,
  aiToolDefinitions,
  aiToolRegistry,
  createAiToolDispatcher,
  type AiToolArguments,
  type AiToolDatabase,
  type AiToolName,
} from "../lib/ai/tools";

const context = { workspaceId: "workspace-a", userId: "user-a" };
const timestamp = new Date("2026-10-20T12:00:00.000Z");
const secret = "secret-must-not-reach-the-model";
const credentials = { access_token: secret, refresh_token: secret, sessionToken: secret };

function tenant(suffix: string) {
  const project = {
    id: `project-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    key: "web",
    name: `Web ${suffix}`,
  };
  const environment = {
    id: `environment-${suffix}`,
    projectId: project.id,
    project,
    key: "production",
    name: "Production",
    sdkKeys: [{ hashedKey: secret, prefix: secret }],
  };
  const configuration = {
    id: `config-${suffix}`,
    environmentId: environment.id,
    environment,
    enabled: true,
    rules: { rules: [], defaultServe: { rolloutPercent: 20 } },
    rolloutPercent: 20,
    offValue: false,
    onValue: true,
    version: 2,
    updatedAt: timestamp,
  };
  const flag = {
    id: `flag-${suffix}`,
    projectId: project.id,
    project,
    key: "checkout",
    name: "New checkout",
    description: "Release the new checkout",
    type: "RELEASE" as const,
    tags: ["checkout"],
    owner: { id: `user-${suffix}`, email: secret, accounts: [credentials] },
    archivedAt: null as Date | null,
    createdAt: timestamp,
    updatedAt: timestamp,
    environments: [configuration],
  };
  const audit = {
    id: `audit-${suffix}`,
    projectId: project.id,
    project,
    flagId: flag.id,
    environmentId: environment.id,
    action: "SDK_KEY_CREATED" as const,
    summary: "Created an SDK key",
    before: { ...credentials, hashedKey: secret },
    after: { rawKey: secret, prefix: secret, token: secret },
    actor: { email: secret, accounts: [credentials] },
    actorName: secret,
    createdAt: timestamp,
  };
  const metric = {
    id: `metric-${suffix}`,
    environmentId: environment.id,
    environment,
    flagKey: flag.key,
    variation: "on",
    metric: "latency_ms",
    value: 120,
    createdAt: timestamp,
    userHash: secret,
  };
  const reference = {
    id: `reference-${suffix}`,
    repositoryId: `repository-${suffix}`,
    repository: {
      id: `repository-${suffix}`,
      workspaceId: project.workspaceId,
      fullName: `example/web-${suffix}`,
      githubRepoId: secret,
      installationId: secret,
      ...credentials,
    },
    flagKey: flag.key,
    filePath: "src/checkout.ts",
    line: 42,
    snippet: 'if (flags.isEnabled("checkout")) renderNewCheckout();',
    lastSeenAt: timestamp,
  };
  return { flag, audit, metric, reference, configuration };
}

type Row = Record<string, unknown>;
type Query = {
  where?: unknown;
  select?: unknown;
  orderBy?: unknown;
  skip?: number;
  take?: number;
};

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

// Evaluate the subset of Prisma predicates used here against two tenants, rather than
// returning the same canned response regardless of whether a workspace filter exists.
function matches(value: unknown, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (!isRow(filter)) return value === filter;
  return Object.entries(filter).every(([key, expected]) => {
    if (expected === undefined || key === "mode") return true;
    if (key === "OR") return (expected as unknown[]).some((entry) => matches(value, entry));
    if (key === "not") return !matches(value, expected);
    if (key === "some") {
      return Array.isArray(value) && value.some((entry) => matches(entry, expected));
    }
    if (key === "contains") {
      return String(value).toLowerCase().includes(String(expected).toLowerCase());
    }
    if (key === "gte") return value instanceof Date && value >= (expected as Date);
    if (key === "lte") return value instanceof Date && value <= (expected as Date);
    return isRow(value) && matches(value[key], expected);
  });
}

function selectRow(row: Row, select: Row): Row {
  return Object.fromEntries(
    Object.entries(select).map(([key, selection]) => {
      const value = row[key];
      if (selection === true) return [key, value];
      assert.ok(isRow(selection) && isRow(selection.select), `Explicit select for ${key}`);
      return [
        key,
        Array.isArray(value)
          ? queryRows(value, selection)
          : selectRow(value as Row, selection.select),
      ];
    }),
  );
}

function queryRows(rows: Row[], query: Query): Row[] {
  const order = Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy ?? {}];
  const matching = rows.filter((row) => matches(row, query.where));
  matching.sort((left, right) => {
    for (const entry of order) {
      for (const [key, direction] of Object.entries(entry as Row)) {
        const a = left[key] instanceof Date ? left[key].toISOString() : String(left[key]);
        const b = right[key] instanceof Date ? right[key].toISOString() : String(right[key]);
        const difference = a.localeCompare(b);
        if (difference) return direction === "desc" ? -difference : difference;
      }
    }
    return 0;
  });
  assert.ok(isRow(query.select), "Every read must have an explicit select");
  const skip = query.skip ?? 0;
  return matching
    .slice(skip, query.take === undefined ? undefined : skip + query.take)
    .map((row) => selectRow(row, query.select as Row));
}

function fixture() {
  const a = tenant("a");
  const b = tenant("b");
  a.flag.environments.push({
    ...b.configuration,
    environment: { ...b.configuration.environment, key: "foreign-only" },
  });
  const data = {
    flags: [a.flag, b.flag],
    audits: [a.audit, b.audit],
    metrics: [a.metric, b.metric],
    references: [a.reference, b.reference],
  };
  const state = { memberPresent: true, membershipError: false };
  const calls: { model: string; args: Query }[] = [];
  function read<Result>(model: string, rows: Row[], args: Query): Result {
    calls.push({ model, args });
    // The fake's projection is runtime-driven; production compatibility is checked below.
    return queryRows(rows, args) as Result;
  }
  const db: AiToolDatabase = {
    member: {
      async findUnique(args) {
        calls.push({ model: "member.findUnique", args });
        assert.deepEqual(args, {
          where: { workspaceId_userId: context },
          select: { id: true },
        });
        if (state.membershipError) throw new Error("Membership lookup unavailable");
        return state.memberPresent ? { id: "member-a" } : null;
      },
    },
    flag: {
      async findMany(args) {
        return read("flag.findMany", data.flags, args);
      },
      async findFirst(args) {
        const rows = read<Row[]>("flag.findFirst", data.flags, { ...args, take: 1 });
        return (rows[0] ?? null) as Awaited<ReturnType<AiToolDatabase["flag"]["findFirst"]>>;
      },
    },
    auditEvent: {
      async findMany(args) {
        return read("auditEvent.findMany", data.audits, args);
      },
    },
    metricEvent: {
      async findMany(args) {
        return read("metricEvent.findMany", data.metrics, args);
      },
    },
    flagReference: {
      async findMany(args) {
        return read("flagReference.findMany", data.references, args);
      },
    },
  };
  return { db, data, state, calls, dispatch: createAiToolDispatcher(context, db) };
}

const validArgs = {
  list_flags: {},
  get_flag: { flagId: "flag-a" },
  get_audit_events: {},
  get_metrics: {},
  get_references: { flagKey: "checkout" },
} satisfies AiToolArguments;
const toolNames = Object.keys(validArgs) as AiToolName[];
const listNames = ["list_flags", "get_audit_events", "get_metrics", "get_references"] as const;

function hasCode(code: AiToolError["code"]) {
  return (error: unknown) => error instanceof AiToolError && error.code === code;
}

test("registry exposes all five typed, described Zod definitions and accepts Prisma clients", () => {
  const acceptPrismaClient = (client: PrismaClient): AiToolDatabase => client;
  assert.equal(typeof acceptPrismaClient, "function");
  assert.deepEqual(
    aiToolDefinitions.map((definition) => definition.name),
    toolNames,
  );
  for (const name of toolNames) {
    const definition = aiToolRegistry[name];
    assert.equal(definition.name, name);
    assert.ok(definition.description.length > 20);
    assert.ok(definition.parameters instanceof z.ZodType);
    assert.ok(definition.parameters.safeParse(validArgs[name]).success);
  }
});

const expectedIds: Record<AiToolName, string> = {
  list_flags: "flag-a",
  get_flag: "flag-a",
  get_audit_events: "audit-a",
  get_metrics: "metric-a",
  get_references: "reference-a",
};

const forbiddenFields = new Set([
  "before",
  "after",
  "actor",
  "actorName",
  "owner",
  "user",
  "email",
  "accounts",
  "sessions",
  "sdkKeys",
  "hashedKey",
  "rawKey",
  "prefix",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "sessionToken",
  "installationId",
  "githubRepoId",
  "userHash",
]);

function assertSafeSelection(select: unknown) {
  assert.ok(isRow(select));
  for (const [field, selection] of Object.entries(select)) {
    assert.ok(!forbiddenFields.has(field), `Forbidden selected field: ${field}`);
    if (isRow(selection)) {
      assert.equal(selection.include, undefined);
      assertSafeSelection(selection.select);
    } else {
      assert.equal(selection, true);
    }
  }
}

for (const name of toolNames) {
  test(`${name}: reads only the trusted workspace using explicit safe selects`, async () => {
    const { dispatch, calls } = fixture();
    const result = await dispatch(name, validArgs[name]);
    const rows = "items" in result ? result.items : [result];
    assert.deepEqual(
      rows.map((row) => row.id),
      [expectedIds[name]],
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, "member.findUnique");
    for (const { args } of calls) {
      assert.equal("include" in args, false);
      assertSafeSelection(args.select);
    }
    const json = JSON.stringify(result);
    assert.ok(!json.includes(secret));
    assert.ok(!json.includes("workspace-b"));
    assert.ok(json.includes(timestamp.toISOString()), "Dates are JSON-ready ISO strings");
    if ("environments" in result) {
      assert.deepEqual(
        result.environments.map((config) => config.environmentId),
        ["environment-a"],
      );
      assert.deepEqual(result.environments[0].rules, {
        rules: [],
        defaultServe: { rolloutPercent: 20 },
      });
    }
  });

  test(`${name}: requires current membership and fails closed on lookup failure`, async () => {
    const { dispatch, calls, state } = fixture();
    await dispatch(name, validArgs[name]);
    calls.length = 0;
    state.memberPresent = false;
    await assert.rejects(dispatch(name, validArgs[name]), hasCode("FORBIDDEN"));
    assert.deepEqual(
      calls.map((call) => call.model),
      ["member.findUnique"],
    );
    calls.length = 0;
    state.membershipError = true;
    await assert.rejects(dispatch(name, validArgs[name]), /Membership lookup unavailable/);
    assert.deepEqual(
      calls.map((call) => call.model),
      ["member.findUnique"],
    );
  });

  test(`${name}: strict validation rejects model identity, unknown keys, and malformed input`, async () => {
    const { dispatch, calls } = fixture();
    const invalid = [
      { ...validArgs[name], workspaceId: "workspace-b" },
      { ...validArgs[name], userId: "user-b" },
      { ...validArgs[name], context },
      { ...validArgs[name], unexpected: true },
      { ...validArgs[name], select: { sdkKeys: true } },
      { ...validArgs[name], where: { project: { workspaceId: "workspace-b" } } },
      { ...validArgs[name], ...JSON.parse('{"__proto__": {"workspaceId": "workspace-b"}}') },
      { ...validArgs[name], take: "10" },
      null,
      undefined,
      [],
      JSON.stringify(validArgs[name]),
    ];
    for (const args of invalid) {
      calls.length = 0;
      await assert.rejects(dispatch(name, args), z.ZodError);
      assert.deepEqual(
        calls.map((call) => call.model),
        ["member.findUnique"],
      );
    }
  });
}

test("foreign IDs cannot bypass workspace filters, and missing flags are indistinguishable", async () => {
  const { dispatch } = fixture();
  const cases: [(typeof listNames)[number], Record<string, string>][] = [
    ["list_flags", { projectId: "project-b" }],
    ["list_flags", { environment: "foreign-only" }],
    ["get_audit_events", { projectId: "project-b" }],
    ["get_audit_events", { flagId: "flag-b" }],
    ["get_audit_events", { environmentId: "environment-b" }],
    ["get_metrics", { projectId: "project-b" }],
    ["get_metrics", { environmentId: "environment-b" }],
    ["get_references", { repositoryId: "repository-b" }],
  ];
  for (const [name, args] of cases) {
    const result = await dispatch(name, { ...validArgs[name], ...args });
    assert.deepEqual(result.items, [], `${name}: ${JSON.stringify(args)}`);
  }
  for (const flagId of ["flag-b", "does-not-exist"]) {
    await assert.rejects(dispatch("get_flag", { flagId }), (error: unknown) => {
      assert.ok(error instanceof AiToolError);
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, "Flag not found.");
      return true;
    });
  }
});

test("audit projections omit both change payloads and account details, including SDK key events", async () => {
  const { dispatch, calls } = fixture();
  const result = await dispatch("get_audit_events", {});
  assert.deepEqual(result.items, [
    {
      id: "audit-a",
      projectId: "project-a",
      flagId: "flag-a",
      environmentId: "environment-a",
      action: "SDK_KEY_CREATED",
      summary: "Created an SDK key",
      createdAt: timestamp.toISOString(),
    },
  ]);
  assert.deepEqual(calls[1].args.select, {
    id: true,
    projectId: true,
    flagId: true,
    environmentId: true,
    action: true,
    summary: true,
    createdAt: true,
  });
});

test("references preserve useful code snippets without repository credentials", async () => {
  const { dispatch, calls, data } = fixture();
  const result = await dispatch("get_references", { flagKey: "checkout" });
  assert.equal(result.items[0].snippet, data.references[0].snippet);
  assert.equal(result.items[0].filePath, "src/checkout.ts");
  assert.equal(result.items[0].line, 42);
  assert.deepEqual(result.items[0].repository, { id: "repository-a", fullName: "example/web-a" });
  assert.deepEqual((calls[1].args.select as Row).repository, {
    select: { id: true, fullName: true },
  });
});

test("dispatcher copies trusted context and handles unknown/prototype tool names safely", async () => {
  const { db, calls, state } = fixture();
  const mutableContext = { ...context };
  const dispatch = createAiToolDispatcher(mutableContext, db);
  mutableContext.workspaceId = "workspace-b";
  mutableContext.userId = "user-b";
  const result = await dispatch("list_flags", {});
  assert.deepEqual(
    result.items.map((row) => row.id),
    ["flag-a"],
  );
  for (const name of ["unknown_tool", "constructor", "toString", "__proto__", "list_flags "]) {
    calls.length = 0;
    await assert.rejects(dispatch(name, {}), hasCode("UNKNOWN_TOOL"));
    assert.deepEqual(
      calls.map((call) => call.model),
      ["member.findUnique"],
    );
  }
  state.memberPresent = false;
  await assert.rejects(dispatch("unknown_tool", {}), hasCode("FORBIDDEN"));
  await assert.rejects(dispatch("get_flag", { workspaceId: "workspace-b" }), hasCode("FORBIDDEN"));
  assert.throws(() => createAiToolDispatcher({ ...context, userId: "" }, db), z.ZodError);
});

for (const name of listNames) {
  test(`${name}: uses bounded default paging and rejects excessive or nonnumeric limits`, async () => {
    const { dispatch, calls } = fixture();
    const result = await dispatch(name, validArgs[name]);
    assert.equal(result.page, 1);
    assert.equal(result.take, 25);
    assert.equal(calls[1].args.take, 25);
    assert.equal(calls[1].args.skip, 0);
    calls.length = 0;
    const lastPage = await dispatch(name, { ...validArgs[name], page: 100, take: 100 });
    assert.deepEqual(lastPage.items, []);
    assert.equal(calls[1].args.skip, 9900);
    assert.equal(calls[1].args.take, 100);
    for (const field of ["page", "take"]) {
      for (const invalid of [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER, Infinity, NaN, "2", null]) {
        calls.length = 0;
        await assert.rejects(dispatch(name, { ...validArgs[name], [field]: invalid }), z.ZodError);
        assert.equal(calls.length, 1, `${field}=${invalid} must not read data`);
      }
    }
  });
}

test("get_flag bounds and scopes nested configurations", async () => {
  const { dispatch, data, calls } = fixture();
  const config = data.flags[0].environments[0];
  for (let index = 0; index < 150; index++) {
    data.flags[0].environments.push({ ...config, id: `config-${index}` });
  }
  const result = await dispatch("get_flag", { flagId: "flag-a" });
  assert.equal(result.environments.length, AI_TOOL_LIMITS.maxEnvironments);
  assert.ok(result.environments.every((item) => item.environmentId === "environment-a"));
  const selection = (calls[1].args.select as Row).environments as Query;
  assert.equal(selection.take, 100);
  assert.deepEqual(selection.where, { environment: { project: { workspaceId: "workspace-a" } } });
});

test("list_flags applies search, status, environment and type filters with stable paging", async () => {
  const { dispatch, data } = fixture();
  const base = data.flags[0];
  data.flags.push(
    { ...base, id: "flag-new", updatedAt: new Date("2026-10-20T14:00:00Z") },
    { ...base, id: "flag-a2" },
    { ...base, id: "flag-old", updatedAt: new Date("2026-10-20T10:00:00Z") },
    { ...base, id: "flag-archived", archivedAt: timestamp },
  );
  const result = await dispatch("list_flags", {
    projectId: "project-a",
    search: "CHECKOUT",
    type: "RELEASE",
    environment: "production",
    page: 2,
    take: 2,
  });
  assert.deepEqual(
    result.items.map((row) => row.id),
    ["flag-a2", "flag-old"],
  );
  assert.deepEqual((await dispatch("list_flags", { type: "OPS" })).items, []);
  assert.deepEqual((await dispatch("list_flags", { search: "unmatched" })).items, []);
  assert.equal((await dispatch("list_flags", { status: "all" })).items.length, 5);
  assert.deepEqual(
    (await dispatch("list_flags", { status: "archived" })).items.map((row) => row.id),
    ["flag-archived"],
  );
});

for (const name of ["get_audit_events", "get_metrics"] as const) {
  test(`${name}: validates date ranges and uses inclusive timestamp filters`, async () => {
    const { dispatch, calls } = fixture();
    const exact = { from: timestamp.toISOString(), to: timestamp.toISOString() };
    assert.equal((await dispatch(name, exact)).items.length, 1);
    assert.deepEqual((calls[1].args.where as Row).createdAt, { gte: timestamp, lte: timestamp });
    assert.deepEqual((await dispatch(name, { from: "2026-10-21T00:00:00Z" })).items, []);
    assert.deepEqual((await dispatch(name, { to: "2026-10-19T00:00:00Z" })).items, []);
    for (const args of [
      { from: "2026-10-21T00:00:00Z", to: "2026-10-19T00:00:00Z" },
      { from: "not-a-date" },
      { to: "2026-02-30T00:00:00Z" },
      { from: timestamp },
    ]) {
      calls.length = 0;
      await assert.rejects(dispatch(name, args), z.ZodError);
      assert.equal(calls.length, 1);
    }
  });
}

test("metrics and references apply domain filters and return empty results for missing data", async () => {
  const { dispatch, data } = fixture();
  const metrics = await dispatch("get_metrics", {
    projectId: "project-a",
    environmentId: "environment-a",
    flagKey: "checkout",
    metric: "latency_ms",
  });
  assert.equal(metrics.items.length, 1);
  assert.equal(metrics.items[0].value, 120);
  assert.deepEqual((await dispatch("get_metrics", { metric: "error_rate" })).items, []);
  assert.deepEqual((await dispatch("get_metrics", { flagKey: "missing" })).items, []);
  assert.deepEqual((await dispatch("get_references", { flagKey: "missing" })).items, []);
  data.flags.length = 0;
  data.audits.length = 0;
  data.metrics.length = 0;
  data.references.length = 0;
  for (const name of listNames) {
    assert.deepEqual(await dispatch(name, validArgs[name]), { items: [], page: 1, take: 25 });
  }
});

test("required identifiers, enums, and string lengths are validated before reading data", async () => {
  const { dispatch, calls } = fixture();
  const cases: [AiToolName, unknown][] = [
    ["get_flag", {}],
    ["get_flag", { flagId: " " }],
    ["get_flag", { flagId: "x".repeat(129) }],
    ["get_references", {}],
    ["get_references", { flagKey: "invalid key" }],
    ["get_references", { flagKey: "x".repeat(81) }],
    ["list_flags", { status: "deleted" }],
    ["list_flags", { type: "INVALID" }],
    ["list_flags", { search: "x".repeat(101) }],
    ["list_flags", { environment: "Invalid Environment" }],
    ["get_audit_events", { projectId: "" }],
    ["get_metrics", { metric: "x".repeat(101) }],
    ["get_metrics", { environmentId: 123 }],
  ];
  for (const [name, args] of cases) {
    calls.length = 0;
    await assert.rejects(dispatch(name, args), z.ZodError);
    assert.equal(calls.length, 1);
  }
});
