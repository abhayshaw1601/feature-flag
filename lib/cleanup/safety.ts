import { staleCleanupOutputSchema, type StaleCleanupOutput } from "../../packages/contracts/src";

export type CleanupFileReview = {
  filePath: string;
  originalContent: string;
  editedContent: string;
  explanation: string;
  addedLines: number;
  removedLines: number;
  diff: { kind: "context" | "added" | "removed"; text: string }[];
};

export type CleanupReview = {
  flagKey: string;
  explanation: string;
  confidence: number;
  status: "READY_FOR_REVIEW" | "NEEDS_MANUAL_REVIEW";
  reasons: string[];
  files: CleanupFileReview[];
};

const MIN_CONFIDENCE = 0.8;
const MAX_CHANGED_LINES = 40;
const MAX_FILES = 100;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_TOTAL_CONTENT_LENGTH = 4_000_000;
const MAX_FILE_LINES = 20_000;
const MAX_TOTAL_LINES = 50_000;
const MAX_LCS_CELLS = 1_000_000;
const MAX_TOTAL_LCS_CELLS = 4_000_000;

type DiffBudget = { lines: number; cells: number };
type LineDiff = Pick<CleanupFileReview, "diff" | "addedLines" | "removedLines">;

function cleanExplanation(explanation: string): string {
  // Remove complete keycaps as well as emoji sequence components, keeping plain digits.
  return explanation
    .replace(
      /[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu,
      "",
    )
    .trim();
}

function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || filePath.length > 4096 || /[\\:*?"<>|]/u.test(filePath)) return false;
  for (const character of filePath) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return filePath
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/^\s|\s$|\.$/u.test(segment) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    );
}

function logicalLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r?\n/u);
  // An EOF terminator is not an extra blank source line. Other blank lines remain.
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function diffContents(
  originalContent: string,
  editedContent: string,
  budget: DiffBudget,
): LineDiff | { reason: string } {
  if (originalContent.length > MAX_CONTENT_LENGTH || editedContent.length > MAX_CONTENT_LENGTH) {
    return { reason: "Content exceeds the safe diff size limit; preview omitted." };
  }

  const original = logicalLines(originalContent);
  const edited = logicalLines(editedContent);
  const lineCount = original.length + edited.length;
  if (
    original.length > MAX_FILE_LINES ||
    edited.length > MAX_FILE_LINES ||
    lineCount > budget.lines
  ) {
    return { reason: "Content exceeds the safe diff line budget; preview omitted." };
  }
  budget.lines -= lineCount;

  // Strip shared ends before allocating a bounded LCS matrix. This keeps small,
  // localized changes to large files cheap without approximating edit counts.
  let start = 0;
  while (start < original.length && start < edited.length && original[start] === edited[start]) {
    start += 1;
  }
  let originalEnd = original.length;
  let editedEnd = edited.length;
  while (
    originalEnd > start &&
    editedEnd > start &&
    original[originalEnd - 1] === edited[editedEnd - 1]
  ) {
    originalEnd -= 1;
    editedEnd -= 1;
  }

  const rows = originalEnd - start;
  const columns = editedEnd - start;
  const width = columns + 1;
  const cells = rows > 0 && columns > 0 ? (rows + 1) * width : 0;
  if (cells > MAX_LCS_CELLS || cells > budget.cells) {
    return { reason: "Diff exceeds the safe comparison work budget; preview omitted." };
  }
  budget.cells -= cells;
  const lcs = new Uint32Array(cells);
  if (cells > 0) {
    for (let row = rows - 1; row >= 0; row -= 1) {
      for (let column = columns - 1; column >= 0; column -= 1) {
        const index = row * width + column;
        lcs[index] =
          original[start + row] === edited[start + column]
            ? 1 + lcs[index + width + 1]
            : Math.max(lcs[index + width], lcs[index + 1]);
      }
    }
  }

  const result: LineDiff = { diff: [], addedLines: 0, removedLines: 0 };
  const append = (kind: CleanupFileReview["diff"][number]["kind"], text: string) => {
    result.diff.push({ kind, text });
    if (kind === "added") result.addedLines += 1;
    if (kind === "removed") result.removedLines += 1;
  };
  for (let index = 0; index < start; index += 1) append("context", original[index]);

  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (original[start + row] === edited[start + column]) {
      append("context", original[start + row]);
      row += 1;
      column += 1;
    } else if (lcs[(row + 1) * width + column] >= lcs[row * width + column + 1]) {
      append("removed", original[start + row]);
      row += 1;
    } else {
      append("added", edited[start + column]);
      column += 1;
    }
  }
  while (row < rows) append("removed", original[start + row++]);
  while (column < columns) append("added", edited[start + column++]);
  for (let index = originalEnd; index < original.length; index += 1) {
    append("context", original[index]);
  }
  return result;
}

/**
 * Pure review gate: schema errors throw; safety failures require manual review.
 * Context must contain exactly the referenced source files, captured by the caller.
 * Previews always use trusted originals. Unresolvable or over-budget previews are
 * omitted with an explicit reason, never presented as zero-change safe diffs.
 */
export function reviewCleanup(
  input: unknown,
  context: { flagKey: string; files: readonly { filePath: string; content: string }[] },
): CleanupReview {
  const output: StaleCleanupOutput = staleCleanupOutputSchema.parse(input);
  const reasons: string[] = [];
  const files: CleanupFileReview[] = [];
  const finish = (): CleanupReview => ({
    flagKey: context.flagKey,
    explanation: cleanExplanation(output.explanation),
    confidence: output.confidence,
    status: reasons.length === 0 ? "READY_FOR_REVIEW" : "NEEDS_MANUAL_REVIEW",
    reasons,
    files,
  });

  if (output.flagKey !== context.flagKey) {
    reasons.push(`Cleanup flag key does not match the requested flag: ${context.flagKey}.`);
  }
  if (output.confidence < MIN_CONFIDENCE) {
    reasons.push(`Confidence ${output.confidence} is below the minimum ${MIN_CONFIDENCE}.`);
  }
  if (context.files.length > MAX_FILES || output.files.length > MAX_FILES) {
    reasons.push(`Cleanup exceeds the safe file count limit of ${MAX_FILES}; previews omitted.`);
    return finish();
  }
  const totalContentLength =
    context.files.reduce((total, file) => total + file.content.length, 0) +
    output.files.reduce(
      (total, file) => total + file.originalContent.length + file.editedContent.length,
      0,
    );
  if (totalContentLength > MAX_TOTAL_CONTENT_LENGTH) {
    reasons.push("Cleanup exceeds the safe total content size limit; previews omitted.");
    return finish();
  }

  const expected = new Map<string, string>();
  for (const file of context.files) {
    if (!isSafeRelativePath(file.filePath)) {
      reasons.push(`Unsafe relative path in trusted source context: ${file.filePath}.`);
      continue;
    }
    if (expected.has(file.filePath)) {
      reasons.push(`Duplicate path in trusted source context: ${file.filePath}.`);
      continue;
    }
    expected.set(file.filePath, file.content);
  }

  const seen = new Set<string>();
  const budget: DiffBudget = { lines: MAX_TOTAL_LINES, cells: MAX_TOTAL_LCS_CELLS };
  for (const file of output.files) {
    const { filePath } = file;
    if (seen.has(filePath)) {
      reasons.push(`Duplicate cleanup path: ${filePath}.`);
      continue;
    }
    seen.add(filePath);
    if (!isSafeRelativePath(filePath)) {
      reasons.push(`Unsafe relative cleanup path: ${filePath}.`);
      continue;
    }
    const originalContent = expected.get(filePath);
    if (originalContent === undefined) {
      reasons.push(`Unknown cleanup path outside the expected source files: ${filePath}.`);
      continue;
    }
    if (file.originalContent !== originalContent) {
      reasons.push(`${filePath}: Model original content does not match the trusted source.`);
    }
    if (/^\s*$/u.test(originalContent)) {
      reasons.push(`${filePath}: Trusted source content is empty or whitespace-only.`);
    }
    if (/^\s*$/u.test(file.editedContent)) {
      reasons.push(
        `${filePath}: Edited content is empty or whitespace-only; destructive deletion.`,
      );
    }

    const result = diffContents(originalContent, file.editedContent, budget);
    if ("reason" in result) {
      reasons.push(`${filePath}: ${result.reason}`);
      continue;
    }
    const changedLines = result.addedLines + result.removedLines;
    if (changedLines === 0) {
      reasons.push(`${filePath}: No actual line edits (no-op or newline-only change).`);
    }
    if (changedLines > MAX_CHANGED_LINES) {
      reasons.push(
        `${filePath}: ${changedLines} changed lines exceeds the maximum ${MAX_CHANGED_LINES}.`,
      );
    }
    files.push({
      filePath,
      originalContent,
      editedContent: file.editedContent,
      explanation: cleanExplanation(file.explanation),
      ...result,
    });
  }

  for (const filePath of expected.keys()) {
    if (!seen.has(filePath)) reasons.push(`Missing cleanup for expected source file: ${filePath}.`);
  }
  if (!files.some((file) => file.addedLines + file.removedLines > 0)) {
    reasons.push("Cleanup must contain a nonempty set of actual edits.");
  }
  return finish();
}
