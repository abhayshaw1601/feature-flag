import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";
import { reviewCleanup, type CleanupReview } from "../lib/cleanup/safety";
import type { StaleCleanupOutput } from "../packages/contracts/src";

const FLAG_KEY = "checkout_refresh";
const FILE_PATH = "src/checkout.ts";

function fixture(
  originalContent = 'const enabled = isEnabled("checkout_refresh");\nrender(enabled);\n',
  editedContent = "const enabled = true;\nrender(enabled);\n",
  filePath = FILE_PATH,
) {
  const output: StaleCleanupOutput = {
    flagKey: FLAG_KEY,
    confidence: 0.9,
    explanation: "Remove the retired checkout flag.",
    files: [
      { filePath, originalContent, editedContent, explanation: "Keep the enabled behavior." },
    ],
  };
  const context = { flagKey: FLAG_KEY, files: [{ filePath, content: originalContent }] };
  return { output, context };
}

function assertManual(review: CleanupReview, reason: RegExp) {
  assert.equal(review.status, "NEEDS_MANUAL_REVIEW");
  assert.ok(
    review.reasons.some((message) => reason.test(message)),
    review.reasons.join("\n"),
  );
}

function numberedLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

for (const confidence of [0.8, 0.79, 1]) {
  test(`confidence ${confidence} respects the inclusive 0.8 gate`, () => {
    const { output, context } = fixture();
    output.confidence = confidence;
    const review = reviewCleanup(output, context);
    assert.equal(review.confidence, confidence);
    assert.equal(review.flagKey, FLAG_KEY);
    if (confidence < 0.8) assertManual(review, /confidence.*0\.8/i);
    else {
      assert.equal(review.status, "READY_FOR_REVIEW");
      assert.deepEqual(review.reasons, []);
    }
  });
}

test("the preview is a real ordered diff of trusted source and proposed content", () => {
  const { output, context } = fixture();
  const review = reviewCleanup(output, context);
  assert.deepEqual(review.files[0], {
    ...output.files[0],
    addedLines: 1,
    removedLines: 1,
    diff: [
      { kind: "removed", text: 'const enabled = isEnabled("checkout_refresh");' },
      { kind: "added", text: "const enabled = true;" },
      { kind: "context", text: "render(enabled);" },
    ],
  });
});

for (const count of [40, 41]) {
  for (const change of ["addition", "removal", "replacement"] as const) {
    test(`${count} changed lines for ${change} respects the inclusive per-file limit`, () => {
      let original = "keep();\n";
      let edited = original;
      if (change === "addition") edited += numberedLines("added", count).join("\n");
      if (change === "removal") original += numberedLines("removed", count).join("\n");
      if (change === "replacement") {
        original += numberedLines("before", 20).join("\n");
        edited += numberedLines("after", count - 20).join("\n");
      }
      const { output, context } = fixture(original, edited);
      const review = reviewCleanup(output, context);
      const file = review.files[0];
      assert.equal(file.addedLines + file.removedLines, count);
      assert.equal(
        file.addedLines,
        change === "removal" ? 0 : change === "addition" ? count : count - 20,
      );
      assert.equal(
        file.removedLines,
        change === "addition" ? 0 : change === "removal" ? count : 20,
      );
      if (count === 40) assert.equal(review.status, "READY_FOR_REVIEW");
      else assertManual(review, /41 changed lines.*40/);
    });
  }
}

test("the 40-line limit applies separately to every expected file", () => {
  const first = fixture("keep();", ["keep();", ...numberedLines("added", 40)].join("\n"));
  const second = fixture(
    "stay();",
    ["stay();", ...numberedLines("extra", 40)].join("\n"),
    "src/other.ts",
  );
  first.output.files.push(second.output.files[0]);
  first.context.files.push(second.context.files[0]);
  const review = reviewCleanup(first.output, first.context);
  assert.equal(review.status, "READY_FOR_REVIEW");
  assert.equal(review.files.length, 2);
  assert.ok(review.files.every((file) => file.addedLines === 40 && file.removedLines === 0));
});

test("inserted and deleted lines do not make shifted unchanged lines look replaced", () => {
  const unchanged = numberedLines("keep", 80);
  const original = ["start", "obsolete", ...unchanged, "end"].join("\n");
  const edited = ["start", ...unchanged, "replacement", "end"].join("\n");
  const { output, context } = fixture(original, edited);
  const review = reviewCleanup(output, context);
  assert.equal(review.status, "READY_FOR_REVIEW");
  const file = review.files[0];
  assert.equal(file.addedLines, 1);
  assert.equal(file.removedLines, 1);
  assert.equal(file.diff.filter((line) => line.kind === "context").length, 82);
  assert.equal(
    file.diff
      .filter((line) => line.kind !== "added")
      .map((line) => line.text)
      .join("\n"),
    original,
  );
  assert.equal(
    file.diff
      .filter((line) => line.kind !== "removed")
      .map((line) => line.text)
      .join("\n"),
    edited,
  );
});

test("repeated lines are matched by sequence rather than unordered membership", () => {
  const { output, context } = fixture("a\nb\na\nb\nc", "b\na\nb\na\nc");
  const review = reviewCleanup(output, context);
  assert.equal(review.status, "READY_FOR_REVIEW");
  assert.equal(review.files[0].addedLines, 1);
  assert.equal(review.files[0].removedLines, 1);
});

test("forged model originals cannot hide destructive changes or control the preview", () => {
  const source = ["keep();", ...numberedLines("remove", 41)].join("\n");
  const { output, context } = fixture(source, "keep();");
  output.files[0].originalContent = "keep();";
  const review = reviewCleanup(output, context);
  assertManual(review, /original content does not match the trusted source/i);
  assertManual(review, /41 changed lines/);
  assert.equal(review.files[0].originalContent, source);
  assert.equal(review.files[0].removedLines, 41);
});

test("original mismatch alone requires manual review, including changed line endings", () => {
  const { output, context } = fixture();
  output.files[0].originalContent = output.files[0].originalContent.replaceAll("\n", "\r\n");
  const review = reviewCleanup(output, context);
  assertManual(review, /original content does not match/i);
  assert.equal(review.files[0].originalContent, context.files[0].content);
  assert.equal(review.files[0].addedLines + review.files[0].removedLines, 2);
});

test("unknown paths have no trusted preview even alongside a valid edit", () => {
  const { output, context } = fixture();
  output.files.push({ ...output.files[0], filePath: "src/unknown.ts" });
  const review = reviewCleanup(output, context);
  assertManual(review, /unknown.*src\/unknown\.ts/i);
  assert.deepEqual(
    review.files.map((file) => file.filePath),
    [FILE_PATH],
  );
});

test("duplicate proposed paths fail closed instead of overwriting the first edit", () => {
  const { output, context } = fixture();
  output.files.push({ ...output.files[0], editedContent: "doSomethingElse();" });
  const review = reviewCleanup(output, context);
  assertManual(review, /duplicate cleanup path/i);
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0].editedContent, output.files[0].editedContent);
});

test("every expected referenced file must be covered", () => {
  const { output, context } = fixture();
  context.files.push({ filePath: "src/second.ts", content: "anotherReference();" });
  const review = reviewCleanup(output, context);
  assertManual(review, /missing.*src\/second\.ts/i);
});

test("duplicate trusted paths are ambiguous and require manual review", () => {
  const { output, context } = fixture();
  context.files.push({ filePath: FILE_PATH, content: "differentTrustedSource();" });
  const review = reviewCleanup(output, context);
  assertManual(review, /duplicate path in trusted source/i);
  assert.equal(review.files[0].originalContent, context.files[0].content);
});

for (const filePath of [
  "../secret.ts",
  "src/../checkout.ts",
  "/src/checkout.ts",
  "C:/src/checkout.ts",
  "C:\\src\\checkout.ts",
  "src\\checkout.ts",
  "//server/share.ts",
  "./src/checkout.ts",
  "src//checkout.ts",
  "src/checkout.ts/",
  "",
  "src/\0checkout.ts",
  "src/\ncheckout.ts",
  "src/checkout.ts ",
  "src/checkout.ts.",
  "src/CON.ts",
  "src/checkout.ts:stream",
]) {
  test(`unsafe relative path ${JSON.stringify(filePath)} is rejected even in trusted context`, () => {
    const { output, context } = fixture(undefined, undefined, filePath);
    const review = reviewCleanup(output, context);
    assertManual(review, /unsafe relative path in trusted source/i);
    assertManual(review, /unsafe relative cleanup path/i);
    assert.deepEqual(review.files, []);
  });
}

test("a traversal alias is rejected rather than normalized to an expected file", () => {
  const { output, context } = fixture();
  output.files[0].filePath = "src/../src/checkout.ts";
  const review = reviewCleanup(output, context);
  assertManual(review, /unsafe relative cleanup path/i);
  assertManual(review, /missing cleanup/i);
});

for (const hasExpectedFiles of [false, true]) {
  test(`empty results fail closed with ${hasExpectedFiles ? "nonempty" : "empty"} context`, () => {
    const { output, context } = fixture();
    output.files = [];
    if (!hasExpectedFiles) context.files = [];
    const review = reviewCleanup(output, context);
    assertManual(review, /nonempty set of actual edits/i);
    if (hasExpectedFiles) assertManual(review, /missing cleanup/i);
    assert.deepEqual(review.files, []);
  });
}

test("a no-op file requires manual review even when another file genuinely changes", () => {
  const { output, context } = fixture();
  const noOp = fixture("keep();", "keep();", "src/unchanged.ts");
  output.files.push(noOp.output.files[0]);
  context.files.push(noOp.context.files[0]);
  const review = reviewCleanup(output, context);
  assertManual(review, /src\/unchanged\.ts: no actual line edits/i);
  assert.equal(review.files[1].addedLines + review.files[1].removedLines, 0);
});

test("a wholly no-op proposal is not an actual edit set", () => {
  const { output, context } = fixture("keep();", "keep();");
  const review = reviewCleanup(output, context);
  assertManual(review, /no actual line edits/i);
  assertManual(review, /nonempty set of actual edits/i);
});

for (const content of ["", " \t\r\n "]) {
  test(`empty/whitespace edited content ${JSON.stringify(content)} cannot delete a file`, () => {
    const { output, context } = fixture(undefined, content);
    const review = reviewCleanup(output, context);
    assertManual(review, /destructive deletion/i);
    assert.equal(review.files[0].editedContent, content);
    assert.ok(review.files[0].removedLines > 0);
  });

  test(`empty/whitespace trusted content ${JSON.stringify(content)} is not a cleanup source`, () => {
    const { output, context } = fixture(content, "newCode();");
    assertManual(reviewCleanup(output, context), /trusted source content is empty/i);
  });
}

test("the review stays bound to the requested flag when the model returns another key", () => {
  const { output, context } = fixture();
  output.flagKey = "different_flag";
  const review = reviewCleanup(output, context);
  assertManual(review, /flag key does not match/i);
  assert.equal(review.flagKey, context.flagKey);
});

test("malformed input throws the shared schema's validation error", () => {
  const { output, context } = fixture();
  const invalidInputs: unknown[] = [
    null,
    undefined,
    [],
    JSON.stringify(output),
    {},
    { ...output, flagKey: null },
    { ...output, explanation: 7 },
    { ...output, files: {} },
    { ...output, files: [{ ...output.files[0], originalContent: null }] },
    { ...output, files: [{ ...output.files[0], editedContent: undefined }] },
    { ...output, files: [{ ...output.files[0], filePath: 5 }] },
    { ...output, files: [{ ...output.files[0], explanation: [] }] },
    ...[NaN, Infinity, -Infinity, -0.1, 1.01, "0.9", undefined].map((confidence) => ({
      ...output,
      confidence,
    })),
  ];
  for (const input of invalidInputs) assert.throws(() => reviewCleanup(input, context), ZodError);
});

for (const [original, edited] of [
  ["old();\nkeep();\n", "newCode();\r\nkeep();\r\n"],
  ["old();\r\nkeep();\r\n", "newCode();\nkeep();"],
  ["old();\nkeep();", "newCode();\r\nkeep();\r\n"],
]) {
  test(`newline conventions do not inflate actual edits: ${JSON.stringify([original, edited])}`, () => {
    const { output, context } = fixture(original, edited);
    const review = reviewCleanup(output, context);
    assert.equal(review.status, "READY_FOR_REVIEW");
    const file = review.files[0];
    assert.equal(file.addedLines, 1);
    assert.equal(file.removedLines, 1);
    assert.equal(file.originalContent, original);
    assert.equal(file.editedContent, edited);
    assert.deepEqual(file.diff, [
      { kind: "removed", text: "old();" },
      { kind: "added", text: "newCode();" },
      { kind: "context", text: "keep();" },
    ]);
  });
}

for (const edited of ["keep();\n", "keep();\r\n", "keep();"]) {
  test(`newline-only proposal ${JSON.stringify(edited)} is a no-op`, () => {
    const { output, context } = fixture("keep();\r\n", edited);
    const review = reviewCleanup(output, context);
    assertManual(review, /no actual line edits/i);
    assert.equal(review.files[0].addedLines, 0);
    assert.equal(review.files[0].removedLines, 0);
  });
}

test("extra blank lines and meaningful whitespace are still real edits", () => {
  const { output, context } = fixture("  keep();  \n", " keep();  \n\n");
  const review = reviewCleanup(output, context);
  assert.equal(review.status, "READY_FOR_REVIEW");
  assert.equal(review.files[0].addedLines, 2);
  assert.equal(review.files[0].removedLines, 1);
  assert.deepEqual(review.files[0].diff, [
    { kind: "removed", text: "  keep();  " },
    { kind: "added", text: " keep();  " },
    { kind: "added", text: "" },
  ]);
});

test("only explanations are emoji-stripped and trimmed; code and paths remain intact", () => {
  const original = '  const label = "🚀 🇮🇳 👩🏽‍💻 1️⃣";  \r\nconst oldValue = "✨";\r\n';
  const edited = '  const label = "🚀 🇮🇳 👩🏽‍💻 1️⃣";  \r\nconst newValue = "✅";\r\n';
  const filePath = "src/🚀 checkout.ts";
  const { output, context } = fixture(original, edited, filePath);
  output.explanation = "  🚀Cleanup at 80% for release 7👩🏽‍💻🇮🇳1️⃣  \n";
  output.files[0].explanation = " \t✅Keep #1 and * syntax ✨ \n";
  const review = reviewCleanup(output, context);
  assert.equal(review.status, "READY_FOR_REVIEW");
  assert.equal(review.explanation, "Cleanup at 80% for release 7");
  assert.equal(review.files[0].explanation, "Keep #1 and * syntax");
  assert.equal(review.files[0].filePath, filePath);
  assert.equal(review.files[0].originalContent, original);
  assert.equal(review.files[0].editedContent, edited);
  assert.deepEqual(review.files[0].diff, [
    { kind: "context", text: '  const label = "🚀 🇮🇳 👩🏽‍💻 1️⃣";  ' },
    { kind: "removed", text: 'const oldValue = "✨";' },
    { kind: "added", text: 'const newValue = "✅";' },
  ]);
});

test("a localized change to a large file uses its common ends without a giant LCS", () => {
  const original = numberedLines("keep", 10_000);
  const edited = [...original];
  edited[5_000] = "changed();";
  const { output, context } = fixture(original.join("\n"), edited.join("\n"));
  const review = reviewCleanup(output, context);
  assert.equal(review.status, "READY_FOR_REVIEW");
  assert.equal(review.files[0].addedLines, 1);
  assert.equal(review.files[0].removedLines, 1);
  assert.equal(review.files[0].diff.length, 10_001);
});

test("large dispersed changes exceeding the comparison budget fail closed without fake counts", () => {
  const original = numberedLines("keep", 1_100);
  const edited = [...original];
  edited[0] = "changedStart();";
  edited[edited.length - 1] = "changedEnd();";
  const { output, context } = fixture(original.join("\n"), edited.join("\n"));
  const review = reviewCleanup(output, context);
  assertManual(review, /comparison work budget.*preview omitted/i);
  assert.deepEqual(review.files, []);
});

test("oversized source text is rejected before allocating a diff", () => {
  const { output, context } = fixture("x".repeat(1_000_001), "keep();");
  const review = reviewCleanup(output, context);
  assertManual(review, /diff size limit.*preview omitted/i);
  assert.deepEqual(review.files, []);
});

test("excessive line counts fail closed even when text fits the character limit", () => {
  const { output, context } = fixture("\n".repeat(20_001) + "keep();", "keep();");
  const review = reviewCleanup(output, context);
  assertManual(review, /diff line budget.*preview omitted/i);
  assert.deepEqual(review.files, []);
});

test("aggregate line work is bounded across otherwise individually small diffs", () => {
  const { output, context } = fixture();
  output.files = [];
  context.files = [];
  const original = numberedLines("keep", 9_000).join("\n");
  for (let index = 0; index < 3; index += 1) {
    const next = fixture(original, `${original}\nadded();`, `src/file${index}.ts`);
    output.files.push(next.output.files[0]);
    context.files.push(next.context.files[0]);
  }
  const review = reviewCleanup(output, context);
  assertManual(review, /diff line budget/i);
  assert.equal(review.files.length, 2);
});

test("aggregate LCS work is bounded across files", () => {
  const { output, context } = fixture();
  output.files = [];
  context.files = [];
  for (let index = 0; index < 5; index += 1) {
    const next = fixture(
      numberedLines("before", 900).join("\n"),
      numberedLines("after", 900).join("\n"),
      `src/file${index}.ts`,
    );
    output.files.push(next.output.files[0]);
    context.files.push(next.context.files[0]);
  }
  const review = reviewCleanup(output, context);
  assertManual(review, /comparison work budget/i);
  assert.equal(review.files.length, 4);
});

test("total content and file count budgets prevent unbounded review output", () => {
  const oversized = fixture("x".repeat(700_000), "y".repeat(700_000));
  const second = fixture("x".repeat(700_000), "y".repeat(700_000), "src/second.ts");
  oversized.output.files.push(second.output.files[0]);
  oversized.context.files.push(second.context.files[0]);
  const sizeReview = reviewCleanup(oversized.output, oversized.context);
  assertManual(sizeReview, /total content size limit/i);
  assert.deepEqual(sizeReview.files, []);

  const manyFiles = fixture();
  manyFiles.output.files = Array.from({ length: 101 }, (_, index) => ({
    ...manyFiles.output.files[0],
    filePath: `src/file${index}.ts`,
  }));
  const countReview = reviewCleanup(manyFiles.output, manyFiles.context);
  assertManual(countReview, /file count limit/i);
  assert.deepEqual(countReview.files, []);
});

test("review is pure and accepts frozen proposal and trusted source objects", () => {
  const { output, context } = fixture();
  const snapshot = structuredClone({ output, context });
  for (const file of output.files) Object.freeze(file);
  for (const file of context.files) Object.freeze(file);
  Object.freeze(output.files);
  Object.freeze(context.files);
  Object.freeze(output);
  Object.freeze(context);
  assert.equal(reviewCleanup(output, context).status, "READY_FOR_REVIEW");
  assert.deepEqual({ output, context }, snapshot);
});
