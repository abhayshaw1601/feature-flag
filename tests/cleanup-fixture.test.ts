import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  cleanupFixtureFiles,
  cleanupFixtureFlags,
  FIXTURE_AS_OF,
  previewCleanupFixture,
  scanCleanupFixture,
} from "../lib/cleanup/fixture";
import { scanRepository } from "../lib/cleanup/scanner";
import { GET, POST } from "../app/api/cleanup/demo/route";

test("fixture scan discovers three stale flags and excludes the active rollout", () => {
  const scan = scanCleanupFixture({}, new Date(FIXTURE_AS_OF));
  assert.equal(scan.mode, "fixture");
  assert.equal(scan.referenceCount, 5);
  assert.equal(scan.fileCount, 5);
  assert.deepEqual(
    scan.candidates.map((candidate) => candidate.flagKey),
    ["checkout_v2", "legacy_search", "pricing_banner"],
  );
  assert.deepEqual(
    scan.candidates.map((candidate) => candidate.daysStale),
    [45, 90, 35],
  );
  assert.equal(scan.candidates[0].referenceCount, 2);
  assert.equal(scan.scannedAt, FIXTURE_AS_OF);
  assert.equal(scanCleanupFixture({ onDays: 100, offDays: 100 }).candidates.length, 0);
});

test("fixtures have safe diffs and a clearly blocked low-confidence proposal", () => {
  for (const key of ["checkout_v2", "legacy_search", "pricing_banner"]) {
    const preview = previewCleanupFixture(key);
    assert.equal(preview.canOpenPullRequest, false);
    assert.equal(preview.mode, "fixture");
    assert.equal(preview.branchName, `flagforge/cleanup-${key}`);
    assert.equal(
      preview.review.status,
      key === "pricing_banner" ? "NEEDS_MANUAL_REVIEW" : "READY_FOR_REVIEW",
    );
    assert.equal(
      scanRepository(
        preview.review.files.map((file) => ({
          filePath: file.filePath,
          content: file.editedContent,
        })),
        [key],
      ).length,
      0,
    );
    for (const file of preview.review.files) {
      assert.ok(file.addedLines + file.removedLines <= 40);
      assert.equal(
        file.originalContent,
        cleanupFixtureFiles.find((source) => source.filePath === file.filePath)?.content,
      );
    }
  }
  assert.throws(() => previewCleanupFixture("search_ranking"));
  assert.throws(() => previewCleanupFixture("checkout_v2", { onDays: 100 }));
});

test("each synthetic edit compiles and retains its selected behavior", () => {
  const names: Record<string, string> = {
    "src/checkout.js": "checkout",
    "src/cart.js": "cartAction",
    "src/search.js": "search",
    "src/pricing.js": "pricing",
  };
  for (const candidate of scanCleanupFixture().candidates) {
    const flag = cleanupFixtureFlags.find((item) => item.key === candidate.flagKey)!;
    const config = flag.environments[0];
    const value = config.enabled ? config.onValue : config.offValue;
    // Only our own fixed fixture strings are executed, never model output or requests.
    const sdk = { isEnabled: () => value === true, getValue: () => value };
    for (const file of previewCleanupFixture(candidate.flagKey).review.files) {
      const evaluate = (source: string) =>
        runInNewContext(
          `${source}\n${names[file.filePath]}(sdk, { id: "fixture-user" })`,
          { sdk },
          { timeout: 1000 },
        );
      assert.equal(evaluate(file.originalContent), evaluate(file.editedContent));
    }
  }
});

test("public demo endpoint only exposes built-in fixtures", async () => {
  const response = GET(new Request("http://localhost/api/cleanup/demo"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).data.candidates.length, 3);
  for (const query of [
    "onDays=0",
    "offDays=NaN",
    "onDays=1.5",
    "workspaceId=private",
    "repo=https://example.com",
  ]) {
    assert.equal(GET(new Request(`http://localhost/api/cleanup/demo?${query}`)).status, 400);
  }
  const post = (body: unknown) =>
    POST(
      new Request("http://localhost/api/cleanup/demo", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const ready = await post({ flagKey: "checkout_v2" });
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).data.canOpenPullRequest, false);
  const manual = await post({ flagKey: "pricing_banner" });
  assert.equal((await manual.json()).data.review.status, "NEEDS_MANUAL_REVIEW");
  assert.equal((await post({ flagKey: "unknown" })).status, 404);
  assert.equal((await post({ flagKey: "checkout_v2", onDays: 100 })).status, 404);
  assert.equal((await post({ flagKey: "checkout_v2", files: [] })).status, 400);
  assert.equal((await post({ flagKey: "checkout_v2", openPullRequest: true })).status, 400);
  assert.equal((await post({ flagKey: "x".repeat(3000) })).status, 413);
  assert.equal(
    (await POST(new Request("http://localhost/api/cleanup/demo", { method: "POST", body: "{" })))
      .status,
    400,
  );
});
