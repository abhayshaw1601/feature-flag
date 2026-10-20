import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createFlagRequestSchema } from "@flagforge/contracts";
import { generateFlagKey } from "../components/flags/create-flag-dialog";
import { auditFieldChanges, readableField, readableValue } from "../components/flags/audit-diff";
import { FlagApiError, requestErrorMessage, requestFlagData } from "../components/flags/flag-api";

test("generated keys stay editable-schema-compatible across common names", () => {
  assert.equal(generateFlagKey(" Checkout refresh "), "checkout_refresh");
  assert.equal(generateFlagKey("Café checkout"), "cafe_checkout");
  assert.equal(generateFlagKey("2026 release"), "flag_2026_release");
  assert.equal(generateFlagKey(""), "");
  for (const name of ["123", "中文", "---", "A".repeat(120), "Guest / checkout"]) {
    const key = generateFlagKey(name);
    assert.ok(key.length <= 80);
    assert.ok(createFlagRequestSchema.safeParse({ name, key, type: "RELEASE" }).success);
  }
});

test("history finds nested changes without treating object-key order as a change", () => {
  assert.deepEqual(auditFieldChanges({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.deepEqual(
    auditFieldChanges(
      { rules: { defaultServe: { rolloutPercent: 0 } }, enabled: false },
      { rules: { defaultServe: { rolloutPercent: 10 } }, enabled: true },
    ),
    [
      { field: "rules.defaultServe.rolloutPercent", before: 0, after: 10 },
      { field: "enabled", before: false, after: true },
    ],
  );
  assert.deepEqual(auditFieldChanges(null, { name: "Checkout", owner: null }), [
    { field: "name", before: undefined, after: "Checkout" },
    { field: "owner", before: undefined, after: null },
  ]);
  assert.deepEqual(
    auditFieldChanges({ tags: ["web", "checkout"] }, { tags: ["checkout", "web"] }),
    [{ field: "tags", before: ["web", "checkout"], after: ["checkout", "web"] }],
  );
});

test("history labels preserve the distinction between absent, null, false and zero", () => {
  assert.equal(readableField("FLAG_CREATED"), "Flag created");
  assert.equal(
    readableField("rules.defaultServe.rolloutPercent"),
    "Rules / Default Serve / Rollout Percent",
  );
  assert.equal(readableValue(undefined), "Not present");
  assert.equal(readableValue(null), "None");
  assert.equal(readableValue(false), "False");
  assert.equal(readableValue(0), "0");
  assert.equal(readableValue(""), 'Empty string ("")');
});

test("client reads validate response contracts and always bypass cached snapshots", async (context) => {
  const fetch = context.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      assert.equal(options.cache, "no-store");
      return Response.json({ data: { total: 0 } });
    },
  );
  assert.deepEqual(await requestFlagData("/flags", z.object({ total: z.number() })), { total: 0 });
  assert.equal(fetch.mock.callCount(), 1);
});

test("server field errors remain available to the create form", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: "DUPLICATE_FLAG_KEY",
          message: "Key already exists.",
          fieldErrors: { key: ["Choose a unique key."] },
        },
      },
      { status: 409 },
    ),
  );
  await assert.rejects(requestFlagData("/flags", z.object({})), (error: unknown) => {
    assert.ok(error instanceof FlagApiError);
    assert.deepEqual(error.fieldErrors, { key: ["Choose a unique key."] });
    assert.equal(requestErrorMessage(error), "Key already exists.");
    return true;
  });
});

test("invalid success payloads and non-JSON errors produce actionable, safe messages", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ data: {} }));
  await assert.rejects(
    requestFlagData("/flags", z.object({ total: z.number() })),
    /unexpected response/,
  );
  fetch.mock.mockImplementation(
    async () => new Response("private upstream detail", { status: 502 }),
  );
  await assert.rejects(
    requestFlagData("/flags", z.object({})),
    /Request failed \(502\). Try again/,
  );
  assert.equal(
    requestErrorMessage(new Error("private network details")),
    "Could not reach the server. Check your connection and try again.",
  );
});
