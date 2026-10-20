import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AiPanel } from "./ai-panel";
import { AiLoading } from "./ai-loading";
import { AiError } from "./ai-error";
import { AiFeedback, type AiFeedbackValue } from "./ai-feedback";
import { AiDemo } from "@/app/ai/ai-demo";

test("generated panels identify mock/live mode and escape model output", () => {
  for (const mock of [true, false]) {
    const html = renderToStaticMarkup(
      <AiPanel model="test-model" mock={mock} actions={<button type="button">Dismiss</button>}>
        {"<script>alert('unsafe')</script>"}
      </AiPanel>,
    );
    assert.match(html, /Generated/);
    assert.match(html, /Model:.*test-model/);
    assert.match(html, mock ? /Mock mode — fixture response/ : /Live model response/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, />Dismiss<\/button>/);
  }
});

test("loading announces progress while skeletons are decorative", () => {
  const html = renderToStaticMarkup(<AiLoading progressText="Validating output…" />);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Validating output…/);
  assert.match(html, /aria-hidden="true"><div class="skeleton/);
});

test("errors announce readable text and expose a retry button with a disabled state", () => {
  const html = renderToStaticMarkup(
    <AiError
      message="The model could not produce valid output."
      onRetry={() => {}}
      retryDisabled
    />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /The model could not produce valid output\./);
  assert.match(html, /<button[^>]*type="button"[^>]*disabled=""/);
  assert.match(html, /Retry<\/button>/);
});

test("feedback has mutually exclusive pressed states and explicitly stays local", () => {
  for (const value of [null, "up", "down"] as AiFeedbackValue[]) {
    const html = renderToStaticMarkup(<AiFeedback value={value} onChange={() => {}} />);
    const buttons = [...html.matchAll(/<button\b[^>]*aria-pressed="(true|false)"[^>]*>/g)];
    assert.deepEqual(
      buttons.map((button) => button[1]),
      [String(value === "up"), String(value === "down")],
    );
    assert.match(html, /aria-label="Response feedback"/);
    assert.match(html, /Helpful<\/button>/);
    assert.match(html, /Not helpful<\/button>/);
    assert.match(html, /Local feedback only\. Not saved or sent\./);
    const noteId = html.match(/aria-describedby="([^"]+)"/)?.[1];
    assert.ok(noteId && html.includes(`id="${noteId}"`));
  }
});

test("demo starts with a labeled single-message form and no fabricated generated response", () => {
  const html = renderToStaticMarkup(
    <AiDemo workspaceId="member-workspace" workspaceName="Member workspace" />,
  );
  assert.match(html, /Test the AI platform/);
  assert.match(html, /Member workspace/);
  assert.match(html, /<label[^>]*for="ai-message"/);
  assert.match(html, /<textarea[^>]*id="ai-message"[^>]*required=""/);
  assert.match(html, /Submit a message to see a validated response\./);
  assert.doesNotMatch(html, /Generated|Apply|fixture response/);
});
