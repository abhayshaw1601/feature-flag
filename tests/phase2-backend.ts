import assert from "node:assert/strict";
import test from "node:test";
import {
  apiErrorSchema,
  auditEventSchema,
  flagDetailSchema,
  flagSummarySchema,
  listFlagsResponseSchema,
} from "@flagforge/contracts";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import {
  createAuditHandler,
  createFlagDetailHandler,
  createProjectFlagsHandlers,
} from "../lib/flag-api";
import { FlagServiceError } from "../lib/flag-errors";
import { parseAuditQuery, parseCreateFlag, parseListFlagsQuery } from "../lib/flag-query";
import { createFlagService, type FlagTransaction } from "../lib/flag-service";

// A small relational transaction harness: predicates, projections, order, and pagination are
// evaluated against multiple projects/workspaces. Writes run on a clone committed only on success.
// This exercises the production service/HTTP handlers without Auth.js, PostgreSQL, or network I/O.
type Row = Record<string, unknown>;
type Query = {
  where?: Row;
  select?: Row;
  include?: Row;
  orderBy?: Row | Row[];
  skip?: number;
  take?: number;
};
type State = {
  workspaces: Row[];
  projects: Row[];
  users: Row[];
  members: Row[];
  environments: Row[];
  flags: Row[];
  configs: Row[];
  audits: Row[];
};

function object(value: unknown): Row {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Row;
}

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
  assert.equal(typeof left, "string");
  assert.equal(typeof right, "string");
  return (left as string) < (right as string) ? -1 : 1;
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (expected instanceof Date) return compare(actual, expected) === 0;
  const filter = object(expected);
  if ("some" in filter) {
    return Array.isArray(actual) && actual.some((row) => matches(object(row), object(filter.some)));
  }
  if ("not" in filter) return !matchesValue(actual, filter.not);
  if ("contains" in filter) {
    if (typeof actual !== "string") return false;
    return filter.mode === "insensitive"
      ? actual.toLowerCase().includes(String(filter.contains).toLowerCase())
      : actual.includes(String(filter.contains));
  }
  if ("gte" in filter || "lte" in filter) {
    return (
      (!filter.gte || compare(actual, filter.gte) >= 0) &&
      (!filter.lte || compare(actual, filter.lte) <= 0)
    );
  }
  return actual !== null && typeof actual === "object" && matches(object(actual), filter);
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (field === "OR") {
      assert.ok(Array.isArray(expected));
      return expected.some((condition) => matches(row, object(condition)));
    }
    if (field === "projectId_key" || field === "workspaceId_userId") {
      return matches(row, object(expected));
    }
    return matchesValue(row[field], expected);
  });
}

function orderRows(a: Row, b: Row, order: Row): number {
  for (const [field, direction] of Object.entries(order)) {
    const comparison =
      typeof direction === "object"
        ? orderRows(object(a[field]), object(b[field]), object(direction))
        : compare(a[field], b[field]) * (direction === "desc" ? -1 : 1);
    if (comparison) return comparison;
  }
  return 0;
}

function projectRow(row: Row, query: Query): Row {
  const result: Row = query.select ? {} : { ...row };
  for (const [field, options] of Object.entries(query.select ?? query.include ?? {})) {
    if (options === true) result[field] = row[field];
    else if (options && row[field] != null) {
      result[field] = Array.isArray(row[field])
        ? selectRows(row[field] as Row[], options as Query)
        : projectRow(object(row[field]), options as Query);
    } else if (options) result[field] = null;
  }
  return result;
}

function selectRows(rows: Row[], query: Query = {}): Row[] {
  let result = rows.filter((row) => matches(row, query.where));
  const orders = Array.isArray(query.orderBy)
    ? query.orderBy
    : query.orderBy
      ? [query.orderBy]
      : [];
  result = result.sort((a, b) => {
    for (const order of orders) {
      const comparison = orderRows(a, b, order);
      if (comparison) return comparison;
    }
    return 0;
  });
  const start = query.skip ?? 0;
  return result
    .slice(start, query.take === undefined ? undefined : start + query.take)
    .map((row) => projectRow(row, query));
}

function seed(): State {
  const date = new Date("2026-01-02T00:00:00.000Z");
  const projects = [
    { id: "p1", workspaceId: "w1", name: "Primary", key: "primary" },
    { id: "p2", workspaceId: "w1", name: "Peer", key: "peer" },
    { id: "empty", workspaceId: "w1", name: "Empty", key: "empty" },
    { id: "foreign", workspaceId: "w2", name: "Private", key: "private" },
  ];
  const environments = [
    ...["qa", "live", "lab", "canary"].map((key) => ({ id: `e-${key}`, projectId: "p1", key })),
    { id: "e-peer", projectId: "p2", key: "staging" },
    { id: "e-foreign", projectId: "foreign", key: "private" },
  ];
  const flags = [
    { id: "f-a", projectId: "p1", key: "alpha", name: "Alpha", type: "RELEASE" },
    { id: "f-b", projectId: "p1", key: "beta", name: "Beta", type: "OPS" },
    {
      id: "f-c",
      projectId: "p1",
      key: "archived",
      name: "Past",
      type: "RELEASE",
      archivedAt: date,
    },
    {
      id: "f-d",
      projectId: "p1",
      key: "checkout_refresh",
      name: "Zeta",
      type: "EXPERIMENT",
      description: "Fresh checkout",
      updatedAt: new Date("2026-01-04T00:00:00.000Z"),
    },
    { id: "f-peer", projectId: "p2", key: "alpha", name: "Peer alpha", type: "RELEASE" },
    { id: "f-secret", projectId: "foreign", key: "alpha", name: "Private alpha", type: "RELEASE" },
  ].map((flag) => ({
    description: null,
    tags: [],
    ownerId: null,
    archivedAt: null,
    createdAt: date,
    updatedAt: date,
    ...flag,
  }));
  const configs = flags.flatMap((flag) =>
    environments
      .filter(
        (environment) =>
          environment.projectId === flag.projectId &&
          (flag.id !== "f-d" || environment.key === "live"),
      )
      .map((environment) => ({
        id: `${flag.id}:${environment.id}`,
        flagId: flag.id,
        environmentId: environment.id,
        enabled: false,
        rules: { rules: [], defaultServe: { rolloutPercent: 0 } },
        rolloutPercent: 0,
        offValue: false,
        onValue: true,
        version: 1,
        createdAt: date,
        updatedAt: date,
      })),
  );
  const audits = [
    {
      id: "a1",
      projectId: "p1",
      flagId: "f-a",
      environmentId: "e-qa",
      actorId: "editor",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    { id: "a2", projectId: "p1", flagId: "f-a", environmentId: "e-qa", actorId: "viewer" },
    { id: "a3", projectId: "p1", flagId: "f-b", environmentId: "e-live", actorId: "editor" },
    {
      id: "a4",
      projectId: "p1",
      flagId: "f-a",
      environmentId: "e-qa",
      actorId: "editor",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    },
    { id: "a-peer", projectId: "p2", flagId: "f-peer", environmentId: "e-peer", actorId: "editor" },
    {
      id: "a-secret",
      projectId: "foreign",
      flagId: "f-secret",
      environmentId: "e-foreign",
      actorId: "outsider",
    },
  ].map((event) => ({
    createdAt: date,
    actorName: "Historical actor",
    action: "ENVIRONMENT_UPDATED",
    summary: "Changed environment.",
    before: false,
    after: true,
    ...event,
  }));
  return {
    workspaces: [
      { id: "w1", name: "Team", slug: "team" },
      { id: "w2", name: "Private", slug: "private" },
    ],
    projects,
    environments,
    flags,
    configs,
    audits,
    users: ["editor", "viewer", "owner", "admin", "outsider"].map((id) => ({
      id,
      name: `${id} name`,
      accessToken: "NEVER_EXPOSE_ACCOUNT_SECRET",
    })),
    members: [
      ...["editor", "viewer", "owner", "admin"].map((userId) => ({
        workspaceId: "w1",
        userId,
        role: userId.toUpperCase(),
      })),
      { workspaceId: "w2", userId: "outsider", role: "OWNER" },
    ],
  };
}

function uniqueError(target: string[] = ["projectId", "key"]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.14.0",
    meta: { modelName: "Flag", target },
  });
}

function harness() {
  const control = {
    state: seed(),
    sessionUser: "editor" as string | null,
    transactions: 0,
    rollbacks: 0,
    failRead: null as Error | null,
    failCreate: null as Error | null,
    failConfig: null as Error | null,
    failAudit: null as Error | null,
    failCommit: null as Error | null,
  };
  let sequence = 0;
  const now = new Date("2026-02-01T00:00:00.000Z");
  const service = createFlagService({
    getSession: async () => (control.sessionUser ? { user: { id: control.sessionUser } } : null),
    transaction: async (work) => {
      control.transactions += 1;
      const state = structuredClone(control.state);
      const user = (id: unknown) => state.users.find((row) => row.id === id) ?? null;
      const project = (row: Row) => ({
        ...row,
        workspace: {
          ...state.workspaces.find((workspace) => workspace.id === row.workspaceId),
          members: state.members
            .filter((member) => member.workspaceId === row.workspaceId)
            .map((member) => ({ ...member, user: user(member.userId) })),
        },
      });
      const flag = (row: Row) => ({
        ...row,
        owner: user(row.ownerId),
        project: project(object(state.projects.find((item) => item.id === row.projectId))),
        environments: state.configs
          .filter((config) => config.flagId === row.id)
          .map((config) => ({
            ...config,
            environment: state.environments.find((item) => item.id === config.environmentId),
          })),
      });
      const audit = (row: Row) => ({ ...row, actor: user(row.actorId) });
      function reader(rows: () => Row[]) {
        return {
          findFirst: async (query: Query) => {
            if (control.failRead) throw control.failRead;
            return selectRows(rows(), query)[0] ?? null;
          },
          findUnique: async (query: Query) => {
            if (control.failRead) throw control.failRead;
            return selectRows(rows(), query)[0] ?? null;
          },
          findMany: async (query: Query) => {
            if (control.failRead) throw control.failRead;
            return selectRows(rows(), query);
          },
          count: async (query: Query) => rows().filter((row) => matches(row, query.where)).length,
        };
      }
      const tx = {
        project: reader(() => state.projects.map(project)),
        member: reader(() => state.members),
        environment: reader(() => state.environments),
        flag: {
          ...reader(() => state.flags.map(flag)),
          create: async (query: Query & { data: Row }) => {
            if (control.failCreate) throw control.failCreate;
            const { environments, ...values } = query.data;
            if (
              state.flags.some(
                (row) => row.projectId === values.projectId && row.key === values.key,
              )
            )
              throw uniqueError();
            const created = {
              ...values,
              id: `created-${++sequence}`,
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            };
            state.flags.push(created);
            const configs = object(environments).create;
            assert.ok(Array.isArray(configs));
            for (const config of configs) {
              state.configs.push({
                ...object(config),
                id: `config-${++sequence}`,
                flagId: created.id,
                createdAt: now,
                updatedAt: now,
              });
              if (control.failConfig) throw control.failConfig;
            }
            return projectRow(flag(created), query);
          },
        },
        auditEvent: {
          ...reader(() => state.audits.map(audit)),
          create: async ({ data }: { data: Row }) => {
            const created = {
              ...data,
              id: `audit-${++sequence}`,
              environmentId: null,
              createdAt: now,
              before: data.before === Prisma.JsonNull ? null : data.before,
            };
            state.audits.push(created);
            if (control.failAudit) throw control.failAudit;
            return created;
          },
        },
      };
      try {
        // Delegate generics model every possible Prisma projection; this harness intentionally
        // implements just the relational operations used here, with a single cast at its boundary.
        const result = await work(tx as unknown as FlagTransaction);
        if (control.failCommit) throw control.failCommit;
        control.state = state;
        return result;
      } catch (error) {
        control.rollbacks += 1;
        throw error;
      }
    },
  });
  return {
    control,
    service,
    projects: createProjectFlagsHandlers(service),
    detail: createFlagDetailHandler(service),
    audit: createAuditHandler(service),
  };
}

const payload = { key: "new_flag", name: "New flag", type: "RELEASE", tags: ["launch"] };
const context = (projectId = "p1") => ({ params: Promise.resolve({ projectId }) });
const request = (path: string, body?: string) =>
  new Request(
    `http://localhost${path}`,
    body === undefined
      ? {}
      : { method: "POST", body, headers: { "Content-Type": "application/json" } },
  );
const status = (expected: number) => (error: unknown) =>
  error instanceof FlagServiceError && error.status === expected;

test("parsing uses contract defaults, trimming, coercion, and rejects unsupported/ambiguous queries", () => {
  assert.deepEqual(parseListFlagsQuery(), {
    status: "active",
    page: 1,
    pageSize: 25,
    sort: "updatedAt",
  });
  assert.deepEqual(
    parseListFlagsQuery(
      new URLSearchParams(
        "search=%20Checkout%20&page=2&pageSize=5&sort=key&type=OPS&status=all&environment=qa",
      ),
    ),
    {
      search: "Checkout",
      page: 2,
      pageSize: 5,
      sort: "key",
      type: "OPS",
      status: "all",
      environment: "qa",
    },
  );
  assert.equal(
    parseCreateFlag({ ...payload, name: "  New flag  ", description: " trimmed " }).description,
    "trimmed",
  );
  for (const query of [
    { status: "enabled" },
    { sort: "createdAt" },
    { environment: "BAD" },
    { action: "FLAG_CREATED" },
    { page: 0 },
    { page: 1.5 },
    { page: 1e30 },
    { pageSize: 101 },
    { search: "x".repeat(101) },
  ]) {
    assert.throws(() => parseListFlagsQuery(query), ZodError);
  }
  assert.throws(() => parseListFlagsQuery(new URLSearchParams("page=1&page=2")), ZodError);
  assert.throws(() => parseCreateFlag({ ...payload, enabled: true }), ZodError);
  assert.throws(() => parseCreateFlag({ ...payload, key: "BAD-KEY" }), ZodError);
  assert.throws(() => parseCreateFlag({ ...payload, name: "  " }), ZodError);
});

test("audit parsing requires scope, validates dates/range, and rejects unknown filters", () => {
  assert.deepEqual(parseAuditQuery({ flagId: "f-a" }), { flagId: "f-a", page: 1, pageSize: 50 });
  for (const input of [
    {},
    { actorId: "editor" },
    { projectId: "p1", from: "yesterday" },
    { projectId: "p1", from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
    { projectId: "p1", action: "FLAG_CREATED" },
  ]) {
    assert.throws(() => parseAuditQuery(input), ZodError);
  }
});

test("every exported service operation requires a real session before database access", async () => {
  const { service, control } = harness();
  control.sessionUser = null;
  for (const operation of [
    () => service.loadFlags("p1"),
    () => service.loadFlagDetail("f-a"),
    () => service.loadFlagHistory("f-a"),
    () => service.loadAudit({ projectId: "p1" }),
    () => service.requireFlagProjectAccess("p1"),
    () => service.createFlag("p1", payload),
  ])
    await assert.rejects(operation, status(401));
  assert.equal(control.transactions, 0);
});

test("viewer may read but cannot create; same-workspace owner/admin/editor may create", async () => {
  const { service, control } = harness();
  control.sessionUser = "viewer";
  assert.equal((await service.loadFlags("p1")).pagination.total, 3);
  assert.equal((await service.loadFlagDetail("f-a")).id, "f-a");
  assert.equal((await service.loadFlagHistory("f-a")).pagination.total, 3);
  const before = structuredClone(control.state);
  await assert.rejects(() => service.createFlag("p1", payload), status(403));
  assert.deepEqual(control.state, before);
  for (const role of ["editor", "admin", "owner"]) {
    control.sessionUser = role;
    await service.createFlag("p1", { ...payload, key: `${role}_flag` });
    assert.equal(control.state.audits.at(-1)?.actorId, role);
  }
});

test("project, flag, history, and audit access cannot cross workspace membership", async () => {
  const { service, control } = harness();
  const before = structuredClone(control.state);
  for (const operation of [
    () => service.loadFlags("foreign"),
    () => service.loadFlagDetail("f-secret"),
    () => service.loadFlagHistory("f-secret"),
    () => service.loadAudit({ projectId: "foreign" }),
    () => service.loadAudit({ projectId: "p1", flagId: "f-secret" }),
    () => service.requireFlagProjectAccess("foreign"),
    () => service.createFlag("foreign", payload),
  ])
    await assert.rejects(operation, status(404));
  control.sessionUser = "signed-in-without-membership";
  await assert.rejects(() => service.loadFlags("p1"), status(404));
  assert.deepEqual(control.state, before);
});

test("shell context is membership-derived and exposes only safe user/workspace fields", async () => {
  const { service } = harness();
  const access = await service.requireFlagProjectAccess("p1");
  assert.deepEqual(access, {
    project: { id: "p1", workspaceId: "w1", name: "Primary", key: "primary" },
    workspace: { id: "w1", name: "Team", slug: "team" },
    role: "EDITOR",
    actor: { id: "editor", name: "editor name" },
  });
  await assert.rejects(() => service.requireFlagProjectAccess("missing"), status(404));
});

test("list query returns exact scope, active/archive/all, search/type, sorts, and stable pages", async () => {
  const { service } = harness();
  const initial = listFlagsResponseSchema.parse(await service.loadFlags("p1"));
  assert.deepEqual(
    initial.items.map((flag) => flag.id),
    ["f-d", "f-a", "f-b"],
  );
  assert.deepEqual(initial.pagination, { page: 1, pageSize: 25, total: 3 });
  assert.deepEqual(
    (await service.loadFlags("p1", { status: "archived" })).items.map((flag) => flag.id),
    ["f-c"],
  );
  assert.equal((await service.loadFlags("p1", { status: "all" })).pagination.total, 4);
  assert.deepEqual(
    (await service.loadFlags("p1", { type: "OPS" })).items.map((flag) => flag.id),
    ["f-b"],
  );
  for (const search of ["CHECKOUT", "zeta", "Fresh"]) {
    assert.deepEqual(
      (await service.loadFlags("p1", { search })).items.map((flag) => flag.id),
      ["f-d"],
    );
  }
  assert.deepEqual(
    (await service.loadFlags("p1", { sort: "name" })).items.map((flag) => flag.name),
    ["Alpha", "Beta", "Zeta"],
  );
  assert.deepEqual(
    (await service.loadFlags("p1", { sort: "key", status: "all" })).items.map((flag) => flag.key),
    ["alpha", "archived", "beta", "checkout_refresh"],
  );
  const second = await service.loadFlags("p1", { page: 2, pageSize: 1 });
  assert.deepEqual(
    second.items.map((flag) => flag.id),
    ["f-a"],
  );
  assert.deepEqual(second.pagination, { page: 2, pageSize: 1, total: 3 });
  assert.deepEqual(
    (await service.loadFlags("p1", { page: 3, pageSize: 1 })).items.map((flag) => flag.id),
    ["f-b"],
  );
  assert.deepEqual(await service.loadFlags("p1", { page: 20 }), {
    items: [],
    pagination: { page: 20, pageSize: 25, total: 3 },
  });
  assert.deepEqual(await service.loadFlags("empty"), {
    items: [],
    pagination: { page: 1, pageSize: 25, total: 0 },
  });
});

test("environment filtering is project-scoped, retains all configs, and rejects invalid environments", async () => {
  const { service, control } = harness();
  const filtered = await service.loadFlags("p1", { environment: "qa" });
  assert.deepEqual(
    filtered.items.map((flag) => flag.id),
    ["f-a", "f-b"],
  );
  assert.equal(filtered.items[0].environments.length, 4);
  for (const environment of ["missing", "private", "staging"]) {
    await assert.rejects(() => service.loadFlags("p1", { environment }), status(400));
  }
  // Even an inconsistent pre-existing config cannot expose another project's environment.
  control.state.configs.push({
    ...control.state.configs[0],
    id: "bad-link",
    environmentId: "e-foreign",
  });
  assert.ok(
    (await service.loadFlagDetail("f-a")).environments.every(
      (config) => config.environmentId !== "e-foreign",
    ),
  );
});

test("create uses actual environments, safe defaults, current actor, and a full readable audit snapshot", async () => {
  const { service, control } = harness();
  const counts = {
    flags: control.state.flags.length,
    configs: control.state.configs.length,
    audits: control.state.audits.length,
  };
  const created = flagSummarySchema.parse(
    await service.createFlag("p1", {
      ...payload,
      ownerId: "viewer",
      description: "  Description  ",
    }),
  );
  assert.equal(created.projectId, "p1");
  assert.equal(created.description, "Description");
  assert.deepEqual(created.owner, { id: "viewer", name: "viewer name" });
  assert.deepEqual(
    created.environments.map((config) => config.environmentId),
    ["e-canary", "e-lab", "e-live", "e-qa"],
  );
  for (const config of created.environments) {
    assert.equal(config.enabled, false);
    assert.deepEqual(config.rules, { rules: [], defaultServe: { rolloutPercent: 0 } });
    assert.equal(config.rolloutPercent, 0);
    assert.equal(config.offValue, false);
    assert.equal(config.onValue, true);
    assert.equal(config.version, 1);
  }
  assert.equal(control.state.flags.length, counts.flags + 1);
  assert.equal(control.state.configs.length, counts.configs + 4);
  assert.equal(control.state.audits.length, counts.audits + 1);
  const detail = flagDetailSchema.parse(await service.loadFlagDetail(created.id));
  assert.deepEqual(flagSummarySchema.parse(detail), created);
  assert.deepEqual(detail.project, { id: "p1", name: "Primary", key: "primary" });
  const history = await service.loadFlagHistory(created.id);
  assert.deepEqual(history.pagination, { page: 1, pageSize: 50, total: 1 });
  const event = auditEventSchema.parse(history.items[0]);
  assert.equal(event.action, "FLAG_CREATED");
  assert.equal(event.before, null);
  assert.deepEqual(event.after, detail);
  assert.deepEqual(event.actor, { id: "editor", name: "editor name" });
  assert.equal(event.actorName, "editor name");
  assert.equal(event.environmentId, null);
  assert.ok(!JSON.stringify(event).includes("NEVER_EXPOSE_ACCOUNT_SECRET"));
  assert.ok((await service.loadFlags("p1")).items.some((flag) => flag.id === created.id));
});

test("owner must be a same-workspace member; omitted/null owner and zero environments are supported", async () => {
  const { service, control } = harness();
  const before = structuredClone(control.state);
  for (const ownerId of ["outsider", "nonexistent"]) {
    await assert.rejects(
      () => service.createFlag("p1", { ...payload, ownerId }),
      (error: unknown) =>
        error instanceof FlagServiceError &&
        error.status === 400 &&
        Boolean(error.fieldErrors?.ownerId),
    );
  }
  assert.deepEqual(control.state, before);
  const emptyProject = await service.createFlag("empty", { ...payload, ownerId: null });
  assert.deepEqual(emptyProject.environments, []);
  assert.equal(emptyProject.owner, null);
  assert.equal((await service.loadFlagHistory(emptyProject.id)).pagination.total, 1);
  assert.equal((await service.createFlag("p2", payload)).owner, null);
});

test("duplicate keys conflict per project, including archived keys; other projects can reuse keys", async () => {
  const { service, control } = harness();
  const before = structuredClone(control.state);
  for (const key of ["alpha", "archived"]) {
    await assert.rejects(
      () => service.createFlag("p1", { ...payload, key }),
      (error: unknown) =>
        error instanceof FlagServiceError &&
        error.status === 409 &&
        Boolean(error.fieldErrors?.key),
    );
  }
  assert.deepEqual(control.state, before);
  await service.createFlag("p1", payload);
  await service.createFlag("p2", payload);
  assert.equal(control.state.flags.filter((flag) => flag.key === payload.key).length, 2);
  // A unique failure reported only at insertion (e.g. a concurrent creator) maps identically.
  control.failCreate = uniqueError();
  await assert.rejects(
    () => service.createFlag("p1", { ...payload, key: "racing_key" }),
    status(409),
  );
  const unrelatedConstraint = uniqueError(["id"]);
  control.failCreate = unrelatedConstraint;
  await assert.rejects(
    () => service.createFlag("p1", payload),
    (error) => error === unrelatedConstraint,
  );
});

test("config, audit, and transaction-commit failures roll back flag, configs, and audit together", async () => {
  for (const failure of ["failConfig", "failAudit", "failCommit"] as const) {
    const { service, control } = harness();
    const before = structuredClone(control.state);
    const error = new Error(`Injected ${failure}`);
    control[failure] = error;
    await assert.rejects(
      () => service.createFlag("p1", payload),
      (actual) => actual === error,
    );
    assert.deepEqual(control.state, before, `${failure} must leave no partial writes`);
    assert.equal(control.rollbacks, 1);
  }
});

test("read/database failures propagate without fixture fallback", async () => {
  const { service, control } = harness();
  const error = new Error("database unavailable");
  control.failRead = error;
  await assert.rejects(
    () => service.loadFlags("p1"),
    (actual) => actual === error,
  );
  await assert.rejects(
    () => service.loadAudit({ projectId: "p1" }),
    (actual) => actual === error,
  );
  await assert.rejects(
    () => service.loadFlagDetail("f-a"),
    (actual) => actual === error,
  );
  await assert.rejects(
    () => service.loadFlagHistory("f-a"),
    (actual) => actual === error,
  );
  await assert.rejects(
    () => service.requireFlagProjectAccess("p1"),
    (actual) => actual === error,
  );
  control.failRead = null;
  await assert.rejects(() => service.loadFlagDetail("missing"), status(404));
  await assert.rejects(() => service.loadFlagHistory("missing"), status(404));
});

test("audit queries apply every filter with stable pagination and inclusive date bounds", async () => {
  const { service } = harness();
  const all = await service.loadAudit({ projectId: "p1" });
  assert.deepEqual(
    all.items.map((event) => event.id),
    ["a4", "a3", "a2", "a1"],
  );
  assert.equal(all.pagination.total, 4);
  const second = await service.loadAudit({ projectId: "p1", page: 2, pageSize: 1 });
  assert.deepEqual(
    second.items.map((event) => event.id),
    ["a3"],
  );
  assert.deepEqual(second.pagination, { page: 2, pageSize: 1, total: 4 });
  assert.deepEqual(
    (await service.loadAudit({ projectId: "p1", page: 3, pageSize: 1 })).items.map(
      (event) => event.id,
    ),
    ["a2"],
  );
  const filtered = await service.loadAudit({
    projectId: "p1",
    flagId: "f-a",
    environmentId: "e-qa",
    actorId: "editor",
    from: "2026-01-01T00:00:00Z",
    to: "2026-01-02T00:00:00Z",
  });
  assert.deepEqual(
    filtered.items.map((event) => event.id),
    ["a1"],
  );
  assert.equal(filtered.pagination.total, 1);
  assert.deepEqual(
    (
      await service.loadAudit({
        projectId: "p1",
        from: "2026-01-02T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      })
    ).items.map((event) => event.id),
    ["a3", "a2"],
  );
  assert.equal(
    (await service.loadAudit({ projectId: "p1", actorId: "outsider" })).pagination.total,
    0,
  );
  assert.deepEqual(
    (await service.loadFlagHistory("f-a")).items.map((event) => event.id),
    ["a4", "a2", "a1"],
  );
  await assert.rejects(() => service.loadAudit({ projectId: "p1", flagId: "f-peer" }), status(404));
  await assert.rejects(
    () => service.loadAudit({ projectId: "p1", environmentId: "e-peer" }),
    status(404),
  );
  await assert.rejects(
    () => service.loadAudit({ flagId: "f-a", environmentId: "e-foreign" }),
    status(404),
  );
});

test("HTTP handlers return the exact list/create/detail/audit envelopes and private cache policy", async () => {
  const { projects, detail, audit } = harness();
  const list = await projects.GET(request("/api/projects/p1/flags?pageSize=1"), context());
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("Cache-Control"), "private, no-store");
  const listBody = await list.json();
  assert.deepEqual(Object.keys(listBody), ["data"]);
  listFlagsResponseSchema.strict().parse(listBody.data);
  assert.equal(listBody.data.items.length, 1);
  const created = await projects.POST(
    request("/api/projects/p1/flags", JSON.stringify(payload)),
    context(),
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  const flag = flagSummarySchema.strict().parse(createdBody.data);
  const read = await detail(request(`/api/flags/${flag.id}`), {
    params: Promise.resolve({ id: flag.id }),
  });
  assert.equal(read.status, 200);
  flagDetailSchema.strict().parse((await read.json()).data);
  const history = await audit(request(`/api/audit?flagId=${flag.id}`));
  assert.equal(history.status, 200);
  const data = (await history.json()).data;
  assert.deepEqual(Object.keys(data).sort(), ["items", "pagination"]);
  assert.deepEqual(data.pagination, { page: 1, pageSize: 50, total: 1 });
  assert.equal(data.items[0].flagId, flag.id);
});

test("HTTP errors: malformed JSON/Zod 400, duplicate 409 with key field, auth 401/403, scoped 404", async () => {
  const { projects, detail, audit, control } = harness();
  for (const body of ["{", "", "null", "[]", JSON.stringify({ ...payload, key: "BAD" })]) {
    const result = await projects.POST(request("/api/projects/p1/flags", body), context());
    assert.equal(result.status, 400);
    apiErrorSchema.parse(await result.json());
  }
  const duplicate = await projects.POST(
    request("/api/projects/p1/flags", JSON.stringify({ ...payload, key: "alpha" })),
    context(),
  );
  assert.equal(duplicate.status, 409);
  assert.ok(apiErrorSchema.parse(await duplicate.json()).error.fieldErrors?.key);
  for (const path of [
    "/api/audit",
    "/api/audit?projectId=p1&from=bad",
    "/api/audit?projectId=p1&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
    "/api/audit?projectId=p1&action=FLAG_CREATED",
  ]) {
    const result = await audit(request(path));
    assert.equal(result.status, 400);
    apiErrorSchema.parse(await result.json());
  }
  const badList = await projects.GET(request("/api/projects/p1/flags?page=0"), context());
  assert.equal(badList.status, 400);
  assert.ok(apiErrorSchema.parse(await badList.json()).error.fieldErrors?.page);
  control.sessionUser = "viewer";
  assert.equal(
    (await projects.POST(request("/api/projects/p1/flags", JSON.stringify(payload)), context()))
      .status,
    403,
  );
  assert.equal(
    (await projects.GET(request("/api/projects/foreign/flags"), context("foreign"))).status,
    404,
  );
  assert.equal(
    (await detail(request("/api/flags/f-secret"), { params: Promise.resolve({ id: "f-secret" }) }))
      .status,
    404,
  );
  control.sessionUser = null;
  assert.equal((await projects.GET(request("/api/projects/p1/flags"), context())).status, 401);
  assert.equal(
    (await projects.POST(request("/api/projects/p1/flags", JSON.stringify(payload)), context()))
      .status,
    401,
  );
  assert.equal((await audit(request("/api/audit?projectId=p1"))).status, 401);
});

test("HTTP internal errors expose/log no raw database error or secret", async () => {
  const { projects, control } = harness();
  control.failRead = new Error("postgres://user:SECRET_PASSWORD@host/database");
  const logs: unknown[][] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...values) => {
    logs.push(values);
  };
  console.warn = (...values) => {
    logs.push(values);
  };
  try {
    const response = await projects.GET(request("/api/projects/p1/flags"), context());
    assert.equal(response.status, 500);
    const body = await response.text();
    apiErrorSchema.parse(JSON.parse(body));
    assert.ok(!body.includes("SECRET_PASSWORD"));
    assert.deepEqual(logs, []);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("invalid stored flag/audit data is an internal error, never blamed on request validation", async () => {
  const { projects, detail, audit, control } = harness();
  control.state.configs[0].rules = { invalid: true };
  assert.equal((await projects.GET(request("/api/projects/p1/flags"), context())).status, 500);
  assert.equal(
    (await detail(request("/api/flags/f-a"), { params: Promise.resolve({ id: "f-a" }) })).status,
    500,
  );
  control.state.audits[0].action = "";
  assert.equal((await audit(request("/api/audit?projectId=p1"))).status, 500);
});
