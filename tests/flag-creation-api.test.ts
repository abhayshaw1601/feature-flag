import assert from "node:assert/strict";
import test from "node:test";
import { generateFlagDraft } from "../lib/flag-creation/generate";
import { flagCreationFixtures } from "../lib/flag-creation/fixtures";
import { FlagCreationError } from "../lib/flag-creation/types";
import {
  contextForProject,
  createFlagPreviewHandler,
  FlagPreviewError,
  type FlagPreviewDependencies,
  type FlagPreviewProject,
} from "../lib/flag-creation/service";
import { flagCreationPreviewResponseSchema } from "../components/flags/flag-creation-preview-data";

const project: FlagPreviewProject = {
  workspaceId: "workspace_a",
  role: "EDITOR",
  environments: [
    { key: "development", name: "Development" },
    { key: "staging", name: "Staging" },
    { key: "production", name: "Production" },
  ],
  flags: [
    {
      key: "archived_checkout",
      environments: [{ rules: flagCreationFixtures[0].draft.environments[0].rules }],
    },
  ],
};
const input = { projectId: "project_a", prompt: flagCreationFixtures[0].sentence };
const request = (body: unknown = input) =>
  new Request("http://localhost/api/ai/flag-creation", {
    method: "POST",
    body: JSON.stringify(body),
  });

function setup(overrides: Partial<FlagPreviewDependencies> = {}) {
  const calls: string[] = [];
  const deps: FlagPreviewDependencies = {
    getUserId: async () => "user_a",
    loadProject: async (projectId, userId) => {
      calls.push(`load:${projectId}:${userId}`);
      return structuredClone(project);
    },
    reserveRun: async ({ userId, workspaceId }) => {
      calls.push(`reserve:${userId}:${workspaceId}`);
      return "run_a";
    },
    generate: async (generation) => {
      calls.push("generate");
      return generateFlagDraft(generation, { env: { AI_MOCK: "true" } });
    },
    completeRun: async (id, result) => {
      calls.push(`complete:${id}:${result.draft.key}`);
    },
    failRun: async (id, code) => {
      calls.push(`fail:${id}:${code}`);
    },
    ...overrides,
  };
  return { handler: createFlagPreviewHandler(deps), calls };
}

test("HTTP preview uses authorized project context and logs a validated mock draft without saving flags", async () => {
  const { handler, calls } = setup();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = flagCreationPreviewResponseSchema.parse(await response.json()).data;
  assert.equal(result.previewOnly, true);
  assert.equal(result.mock, true);
  assert.equal(result.draft.key, "new_checkout");
  assert.equal(result.draft.environments[0].rules.rules[0].serve.rolloutPercent, 10);
  assert.deepEqual(calls, [
    "load:project_a:user_a",
    "reserve:user_a:workspace_a",
    "generate",
    "complete:run_a:new_checkout",
  ]);
});

test("authentication precedes context reads and generation", async () => {
  const { handler, calls } = setup({ getUserId: async () => null });
  assert.equal((await handler(request())).status, 401);
  assert.deepEqual(calls, []);
});

test("inaccessible and missing projects do not reach the model", async () => {
  const { handler, calls } = setup({ loadProject: async () => null });
  assert.equal((await handler(request())).status, 404);
  assert.deepEqual(calls, []);
});

test("viewers cannot spend AI budget or generate", async () => {
  const { handler, calls } = setup({ loadProject: async () => ({ ...project, role: "VIEWER" }) });
  assert.equal((await handler(request())).status, 403);
  assert.deepEqual(calls, []);
});

test("context trusts saved attributes, not user-supplied attribute lists", async () => {
  const context = contextForProject(project, false);
  assert.deepEqual(context.existingFlagKeys, ["archived_checkout"]);
  assert.deepEqual(context.knownUserAttributes, ["country", "plan"]);
  assert.equal(context.allowProduction, false);
  const { handler, calls } = setup();
  assert.equal((await handler(request({ ...input, knownUserAttributes: ["secret"] }))).status, 400);
  assert.deepEqual(calls, []);
});

test("fresh projects cannot silently invent targeting attributes", async () => {
  const { handler, calls } = setup({ loadProject: async () => ({ ...project, flags: [] }) });
  const response = await handler(request());
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "INSUFFICIENT_CONTEXT");
  assert.ok(calls.includes("fail:run_a:INSUFFICIENT_CONTEXT"));
});

test("production output without explicit opt-in is rejected and recorded as failed", async () => {
  const { handler, calls } = setup();
  const response = await handler(request({ ...input, prompt: flagCreationFixtures[9].sentence }));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PRODUCTION_NOT_ALLOWED");
  assert.ok(calls.includes("fail:run_a:PRODUCTION_NOT_ALLOWED"));
});

test("explicit Production checkbox plus affirmative request allows only a preview", async () => {
  const { handler } = setup();
  const response = await handler(
    request({ ...input, prompt: flagCreationFixtures[9].sentence, allowProduction: true }),
  );
  assert.equal(response.status, 200);
  const result = flagCreationPreviewResponseSchema.parse(await response.json()).data;
  assert.equal(result.previewOnly, true);
  assert.equal(result.draft.environments[0].enabled, true);
});

test("malformed JSON, oversized requests, and overlong prompts are clean errors", async () => {
  const { handler, calls } = setup();
  assert.equal(
    (await handler(new Request("http://localhost/", { method: "POST", body: "{" }))).status,
    400,
  );
  assert.equal((await handler(request({ ...input, prompt: "x".repeat(17000) }))).status, 413);
  assert.equal((await handler(request({ ...input, prompt: "x".repeat(2001) }))).status, 400);
  assert.deepEqual(calls, []);
});

test("budget refusal fails closed before provider call", async () => {
  const { handler, calls } = setup({
    reserveRun: async () => {
      throw new FlagPreviewError(429, "RATE_LIMITED", "Try again shortly.");
    },
  });
  assert.equal((await handler(request())).status, 429);
  assert.deepEqual(calls, ["load:project_a:user_a"]);
});

test("provider failure uses safe public errors and logs only an error code", async () => {
  const { handler, calls } = setup({
    generate: async () => {
      throw new FlagCreationError("PROVIDER_ERROR");
    },
  });
  const response = await handler(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PROVIDER_ERROR");
  assert.ok(calls.includes("fail:run_a:PROVIDER_ERROR"));
});

test("unexpected errors and failed logging never leak internal details", async () => {
  const { handler } = setup({
    generate: async () => {
      throw new Error("private database payload");
    },
    failRun: async () => {
      throw new Error("private log failure");
    },
  });
  const response = await handler(request());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private/);
});

test("invalid stored rules fail before budget reservation", async () => {
  const { handler, calls } = setup({
    loadProject: async () => ({
      ...project,
      flags: [{ key: "broken", environments: [{ rules: null }] }],
    }),
  });
  const response = await handler(request());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_CONTEXT");
  assert.deepEqual(calls, []);
});
