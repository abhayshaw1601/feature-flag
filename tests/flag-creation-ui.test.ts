import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FlagCreationBar } from "../components/flags/flag-creation-bar";
import { FlagCreationPreviewDrawer } from "../components/flags/flag-creation-preview";
import {
  flagCreationPreviewResponseSchema,
  previewText,
} from "../components/flags/flag-creation-preview-data";
import { flagCreationFixtures } from "../lib/flag-creation/fixtures";

test("command bar renders examples, bounded prompt, and Production opt-in off by default", () => {
  const html = renderToStaticMarkup(
    createElement(FlagCreationBar, { projectId: "fixture", canGenerate: true, demo: true }),
  );
  assert.match(html, /Describe a flag in plain English/);
  assert.match(html, /Kill switch for payments/);
  assert.match(html, /minLength="10"/);
  assert.match(html, /maxLength="2000"/);
  assert.match(html, /Local fixture demo/);
  const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox, /checked/);
});

test("viewer and missing-project access states disable generation", () => {
  for (const props of [{ projectId: "p", canGenerate: false }, { canGenerate: true }]) {
    const html = renderToStaticMarkup(createElement(FlagCreationBar, props));
    assert.match(html, /<textarea[^>]*disabled/);
    assert.match(html, /<button[^>]*type="submit"[^>]*disabled/);
    assert.match(html, /project context is required|Viewer access is read-only/);
  }
});

test("drawer renders actual targeting and assumptions above disabled Create", () => {
  const draft = structuredClone(flagCreationFixtures[0].draft);
  draft.name = "<script>alert(1)</script>";
  const html = renderToStaticMarkup(
    createElement(FlagCreationPreviewDrawer, {
      preview: { draft, model: "mock:flag-creation.v1", mock: true, previewOnly: true },
      environments: [
        { key: "staging", name: "Staging" },
        { key: "production", name: "Production" },
      ],
      allowProduction: false,
      returnFocusRef: { current: null },
      editTargetRef: { current: null },
      onDismiss: () => undefined,
    }),
  );
  assert.match(html, /<dialog/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Mock fixture/);
  assert.match(html, /country/);
  assert.match(html, /plan/);
  assert.match(html, /10%/);
  assert.match(html, /Default rollout/);
  assert.match(html, /<button[^>]*>Create<\/button>/);
  assert.ok(html.indexOf("Assumptions") < html.lastIndexOf(">Create<"));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("client rejects non-preview or malformed response contracts", () => {
  const valid = {
    data: {
      draft: flagCreationFixtures[0].draft,
      model: "mock:flag-creation.v1",
      mock: true,
      previewOnly: true,
    },
  };
  assert.equal(flagCreationPreviewResponseSchema.safeParse(valid).success, true);
  assert.equal(
    flagCreationPreviewResponseSchema.safeParse({ data: { ...valid.data, previewOnly: false } })
      .success,
    false,
  );
  assert.equal(
    flagCreationPreviewResponseSchema.safeParse({ data: { ...valid.data, draft: {} } }).success,
    false,
  );
  assert.equal(previewText("  Safe \u{1F680} draft  "), "Safe  draft");
});
