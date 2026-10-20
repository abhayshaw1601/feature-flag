# Phase 7: stale flag cleanup

## Status

Started with a complete **fixture-only scan and review flow**. This is not the live GitHub integration. No repository is connected, no model is called, and no branch, commit, PR, database row, or flag archive is written.

## Try it

Use Node from `.nvmrc` and the root lockfile:

```bash
npm ci
npm run db:generate
npm run dev
```

Open <http://localhost:3000/demo/cleanup>. This public page and its API only expose built-in synthetic fixtures and need no database, Gemini, or GitHub credentials. `/repositories` and `/stale-flags` use the existing GitHub-session/workspace gate and clearly label the same fixture data; they do not yet load live workspace repositories.

For a parallel Linux preview, avoid sharing Next's output directory with other running builds:

```bash
NEXT_BUILD_DIR=node_modules/.cache/phase7-next npm run dev -- --port 3007
```

Then open <http://localhost:3007/demo/cleanup>. Leave `NEXT_BUILD_DIR` unset for the normal production build and Docker deployment; their output stays in `.next`.

1. Open **Repositories**, scan the fixture, and expand the reference list. It contains five references in five JavaScript files.
2. Open **Stale flags**. The default thresholds find three candidates: `checkout_v2` (45 days on), `legacy_search` (90 days off), and `pricing_banner` (35 days on). The active `search_ranking` rollout is excluded.
3. Preview `checkout_v2` to review the two-file diff and proposed branch name. The PR button is disabled because this is a fixture, even though its review passes the structural checks.
4. Preview `pricing_banner` to see **Needs manual review** at 72% confidence.
5. Expand **Age thresholds** and apply 100 days to both thresholds for the empty state. Restore the default inputs and apply them to recover the candidates. Search filters the current list.

The configuration snapshot is fixed at `2026-10-20T12:00:00Z` for reproducible ages. The scan timestamp records when the fixture was evaluated. Rescanning never contacts GitHub. The fixture flow stays a fixture regardless of `AI_MOCK`; a disabled mock flag is not permission to send source code elsewhere.

## Implemented boundaries

- `lib/cleanup/scanner.ts`: static literal `isEnabled`/`getValue` discovery in JS/TS-family files; handles quotes, multiline calls, generic calls and common JSX contexts, excludes comments/strings and generated/vendor paths, includes line numbers and surrounding code.
- `lib/cleanup/stale.ts`: complete, unique environment coverage; all ON at 100% including default/rule targeting, or all disabled; configurable 30/60-day thresholds; matching served values; no archived/unreferenced flags. Uses the latest configuration timestamp or creation date conservatively.
- `lib/cleanup/safety.ts`: shared Zod output validation, trusted-original comparison, exact path/file coverage, minimum confidence 0.8, maximum **added + removed** lines of 40 per file, bounded LCS diffs, safe relative paths, duplicate/no-op/deletion rejection. Limits fail closed to manual review.
- `lib/cleanup/fixture.ts`: synthetic repository, flag snapshots, predetermined edits, and review composition. The returned `canOpenPullRequest` is always false.
- `app/api/cleanup/demo/route.ts`: GET scans fixtures; POST accepts only a fixture flag key and thresholds, with a 2 KB body bound. Invalid/extra fields are rejected; responses use `no-store`. It accepts no repository URLs, source contents, workspace IDs, credentials, or write commands.
- `components/cleanup/`: repository list, scan time/reference counts, candidate search/thresholds, code diffs, loading skeleton, error/retry, empty and success states. All generated text is explicitly labelled as a deterministic fixture.

Only explanations are emoji-sanitized; source bytes must never be changed by a display sanitizer. Code renders as escaped React text.

## Tests

```bash
npm run test:cleanup
npm test
```

The cleanup suite runs offline and is included in the root `npm test` pipeline via `test:smoke`. It covers scanner false positives and exclusions; age, targeting, values and environment boundaries; confidence 0.79/0.8; change counts 40/41; forged originals; unsafe/duplicate/missing paths; invalid and oversized requests; newline handling; diff work budgets; and the composed fixture API. Trusted fixture edits are compiled/executed in tests to check the selected behavior is preserved. This is **not** a claim that AI edits or a real repository's build were tested.

### Verification from this implementation session

- `npm run test:cleanup`: 84 tests passed (17 scanner/stale, 63 safety, 4 fixture/API integration).
- Targeted ESLint and Prettier checks passed for Phase 7 source and tests. `npm run typecheck` passed after regenerating Prisma's client for concurrent schema changes.
- The final `npm test` run passed its unit suites, contracts build, Prisma validation and TypeScript check, then reached the four-minute command timeout during repository-wide ESLint. The full pipeline and its final formatting stage are not claimed as passed.
- The real Next.js `/demo/cleanup` returned HTTP 200. Chromium exercised previews, the 72% manual-review case, disabled PR action, focus restoration, search, threshold changes, empty states, simulated network failure/retry, and the five repository references. No browser JavaScript exceptions were reported.
- Final visual inspection of the candidate list at 1440, 768 and 390 pixels: zero failures and zero warnings. The existing brand palette was explicitly allowed. Preview screenshots at all three widths and the dark manual-review state were also checked; no horizontal page overflow was detected.
- An isolated production build (`NEXT_BUILD_DIR=node_modules/.cache/phase7-build npm run build`) timed out after six minutes during compilation; production output is not verified by this session. No database integration or live provider/GitHub checks were run.

Design notes: the Framed sheet direction (seed `1277071664`) informed the list and review panels; the existing shell, Inter/JetBrains Mono and brand tokens were preserved rather than redesigned. The screen answers which old flags still have code references; the signature evidence is the per-file removal diff. Review of the first screenshots led to collapsible age controls, larger candidate evidence text, and scrolling/focusing the generated preview. The final list shares its left/right edges and shows real fixture-derived counts; mobile navigation folds and code scrolls inside its own frame. The existing global environment selector remains shell chrome: cleanup is explicitly scoped to all environments.

## Remaining implementation

1. Create/install a GitHub App on explicitly chosen repositories. Required permissions: **Contents read/write**, **Pull requests read/write**, **Metadata read**. Keep its ID, private key and webhook secret in the existing environment variables, never in source control or browser code.
2. Implement an authenticated, workspace-scoped installation binding and Octokit adapter. Verify repository access, paginate trees, detect truncated scans, bound file sizes, pin a commit SHA, and persist `Repository`/`FlagReference` data atomically. Do not treat a partial scan as complete.
3. Use the Phase 4 **Gemini-only** structured-output helper, rate/budget limits and `AiRun` logging. Send only authorized repository context. Treat source code as untrusted prompt input. Apply the shared safety checks to real output and show the returned diff for explicit approval.
4. Store a server-owned proposal tied to workspace, repository, flag, config versions, source SHA and reviewed contents. On approval recheck role, complete environment state, source hashes, safety, and proposal freshness. Do not accept edited contents or confidence supplied by the browser as trusted approval data.
5. Create `flagforge/cleanup-<flagKey>`, one commit per file, and a PR with explanation, file list, and flag link. Handle existing branches/PRs and retries idempotently; no force pushes. Run the target repository's existing checks.
6. Add an HMAC-verified, replay-safe merge webhook. Match the exact recorded installation/repository/PR and expected merged commit, recheck flag state and remaining references, then archive with an audit event. An arbitrary merge event must never archive a flag.

## Known limits

The scanner is a conservative lexer, not symbol resolution. Aliases, dynamic/computed/escaped keys and template interpolations can be missed; unrelated same-named functions can match. Audit continuity cannot be proved from snapshots alone: every config edit must update `updatedAt`, and callers must supply the complete environment inventory. Removing flag evaluation can also change fallback behavior and exposure events. Neither candidate detection nor a high confidence score proves an edit safe. Live PR generation and merge archiving remain unimplemented, and Phase 7's three-real-PR acceptance criterion remains unmet.
