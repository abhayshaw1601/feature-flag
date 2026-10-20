import { z } from "zod";
import { flagSummarySchema, type FlagSummary } from "../../packages/contracts/src";
import { scanRepository, type RepositoryFile } from "./scanner";
import { findStaleCandidates } from "./stale";
import { reviewCleanup } from "./safety";

// This dataset is intentionally independent of live workspace data and credentials.
export const FIXTURE_AS_OF = "2026-10-20T12:00:00.000Z";
export const fixtureEnvironmentKeys = ["development", "staging", "production"] as const;
export const cleanupThresholdsSchema = z.object({
  onDays: z.coerce.number().int().min(1).max(3650).default(30),
  offDays: z.coerce.number().int().min(1).max(3650).default(60),
});

function fixtureFlag(key: string, name: string, days: number, enabled: boolean, rollout = 100) {
  const updatedAt = new Date(Date.parse(FIXTURE_AS_OF) - days * 86_400_000).toISOString();
  return flagSummarySchema.parse({
    id: `fixture_${key}`,
    projectId: "fixture_storefront",
    key,
    name,
    description: "Synthetic flag for the Phase 7 cleanup demo.",
    type: "RELEASE",
    tags: ["fixture"],
    owner: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    environments: fixtureEnvironmentKeys.map((environmentKey) => ({
      environmentId: `fixture_${environmentKey}`,
      environmentKey,
      enabled,
      rules: { rules: [], defaultServe: { rolloutPercent: rollout } },
      rolloutPercent: rollout,
      onValue: key === "pricing_banner" ? "Simple pricing for every team" : true,
      offValue: key === "pricing_banner" ? "Choose a plan" : false,
      version: 1,
      updatedAt,
    })),
  });
}

export const cleanupFixtureFlags: FlagSummary[] = [
  fixtureFlag("checkout_v2", "Checkout v2", 45, true),
  fixtureFlag("legacy_search", "Legacy search", 90, false),
  fixtureFlag("pricing_banner", "Pricing banner", 35, true),
  fixtureFlag("search_ranking", "Search ranking", 7, true, 10),
];

export const cleanupFixtureFiles: RepositoryFile[] = [
  {
    filePath: "src/checkout.js",
    content: [
      "function checkout(sdk, user) {",
      '  if (sdk.isEnabled("checkout_v2", user, false)) {',
      '    return "express checkout";',
      "  }",
      '  return "classic checkout";',
      "}",
      "",
    ].join("\n"),
  },
  {
    filePath: "src/cart.js",
    content: [
      "function cartAction(sdk, user) {",
      '  return sdk.isEnabled("checkout_v2", user, false)',
      '    ? "Continue to express checkout"',
      '    : "Continue to checkout";',
      "}",
      "",
    ].join("\n"),
  },
  {
    filePath: "src/search.js",
    content: [
      "function search(sdk, user) {",
      '  if (sdk.isEnabled("legacy_search", user, false)) {',
      '    return "legacy results";',
      "  }",
      '  return "current results";',
      "}",
      "",
    ].join("\n"),
  },
  {
    filePath: "src/pricing.js",
    content: [
      "function pricing(sdk, user) {",
      '  return sdk.getValue("pricing_banner", user, "Choose a plan");',
      "}",
      "",
    ].join("\n"),
  },
  {
    filePath: "src/ranking.js",
    content: [
      "function ranking(sdk, user) {",
      '  return sdk.isEnabled("search_ranking", user, false) ? "new ranking" : "stable ranking";',
      "}",
      "",
    ].join("\n"),
  },
];

export function scanCleanupFixture(input: unknown = {}, scannedAt = new Date()) {
  const thresholds = cleanupThresholdsSchema.parse(input);
  const references = scanRepository(
    cleanupFixtureFiles,
    cleanupFixtureFlags.map((flag) => flag.key),
  );
  const candidates = findStaleCandidates(cleanupFixtureFlags, references, {
    now: new Date(FIXTURE_AS_OF),
    environmentKeys: fixtureEnvironmentKeys,
    ...thresholds,
  });
  return {
    mode: "fixture" as const,
    asOf: FIXTURE_AS_OF,
    scannedAt: scannedAt.toISOString(),
    repository: { id: "fixture_storefront", fullName: "northstar-demo/storefront", branch: "main" },
    thresholds,
    referenceCount: references.length,
    fileCount: cleanupFixtureFiles.length,
    references,
    candidates,
  };
}

export type CleanupScan = ReturnType<typeof scanCleanupFixture>;

const fixtureEdits: Record<string, string> = {
  "src/checkout.js": 'function checkout(sdk, user) {\n  return "express checkout";\n}\n',
  "src/cart.js": 'function cartAction(sdk, user) {\n  return "Continue to express checkout";\n}\n',
  "src/search.js": 'function search(sdk, user) {\n  return "current results";\n}\n',
  "src/pricing.js": 'function pricing(sdk, user) {\n  return "Simple pricing for every team";\n}\n',
};

export class FixtureCandidateError extends Error {}

export function previewCleanupFixture(flagKey: string, thresholds: unknown = {}) {
  const scan = scanCleanupFixture(thresholds);
  const candidate = scan.candidates.find((item) => item.flagKey === flagKey);
  if (!candidate) throw new FixtureCandidateError("This flag is not a current fixture candidate.");
  const paths = new Set(candidate.references.map((reference) => reference.filePath));
  const files = cleanupFixtureFiles.filter((file) => paths.has(file.filePath));
  const explanation =
    candidate.reason === "ON_EVERYWHERE"
      ? "Keep the fully rolled-out behavior and remove the unreachable fallback branch."
      : "Keep the current behavior and remove the disabled legacy branch.";
  const review = reviewCleanup(
    {
      flagKey,
      confidence: flagKey === "pricing_banner" ? 0.72 : 0.96,
      explanation,
      files: files.map((file) => ({
        filePath: file.filePath,
        originalContent: file.content,
        editedContent: fixtureEdits[file.filePath],
        explanation,
      })),
    },
    { flagKey, files },
  );
  // Defense in depth for future generated proposals; discovery is not semantic proof.
  const remaining = scanRepository(
    review.files.map((file) => ({ filePath: file.filePath, content: file.editedContent })),
    [flagKey],
  );
  if (remaining.length > 0) {
    review.status = "NEEDS_MANUAL_REVIEW";
    review.reasons.push("The proposed edits still contain references to this flag.");
  }
  return {
    mode: "fixture" as const,
    model: "Deterministic fixture; no model called",
    canOpenPullRequest: false as const,
    branchName: `flagforge/cleanup-${flagKey}`,
    review,
  };
}

export type CleanupPreview = ReturnType<typeof previewCleanupFixture>;
