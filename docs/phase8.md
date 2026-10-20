# Phase 8: plain-English audit summaries

Status: usable audit/digest increment with persisted summary enrichment. Automatic enrichment of **every** audit writer and deployed/live-provider acceptance remain open.

## Try it

For the real authenticated application, apply the additive migration to the intended application database before starting the updated Prisma client:

```bash
npm run db:migrate:deploy
npm run db:generate
npm run dev
```

Open `/audit` using the existing Audit log navigation. The page reads the current workspace's real audit events, with project, flag, actor, environment, UTC date-range and 24-hour/7-day filters. Each row includes source/model labels and an expandable before/after snapshot. Recognizable credential fields are redacted in these snapshots.

Editors and higher can click **Generate summaries** to enrich up to 20 visible fallback rows, then refresh the persisted results. Viewers can read but cannot spend AI budget or update summaries. The dashboard includes a compact 24-hour workspace digest. **Export Markdown** downloads the exact displayed digest data, not a separate model response.

`/demo/audit` is a public, local fixture demonstration. It uses 60 events, two projects, and a fixed clock of `2026-10-20T12:00:00.000Z`. Filters, pagination, diffs and export work without an account, database, or API key. Its deterministic summaries are explicitly not labeled as live Gemini output, and generation is disabled.

The migration was applied and tested on a disposable local database only. This task did not migrate the configured application database or read/change provider credentials.

## Grounding and caching

1. Existing audit writes already store a nonempty deterministic `summary` in their transaction. Reads never invoke the model.
2. `lib/audit/summaries.ts` derives a small set of equivalent candidate sentences from the action, actor, flag/environment identity and validated before/after facts. Default rollout is not confused with targeted exposure. Unknown or contradictory data yields an explicit generic sentence rather than invented values.
3. `lib/audit/generate.ts` uses Phase 4 `runAi`, its configured **fast Gemini model**, durable admission control, retry, sanitization and `AiRun` logging. The model receives only event IDs and allowed sentences, not raw audit snapshots or credentials. It must return each requested ID exactly once and an exact allowed sentence. This intentionally restricts wording instead of accepting ungrounded free-form prose.
4. `summary`, `summarySource`, `summaryModel`, `summaryVersion` and `summarizedAt` are persisted on the event. The additive migration is `prisma/migrations/20261020080000_audit_summaries/migration.sql`. Original before/after data is unchanged. Reads verify cached prose against current supported facts and fall back if it is stale or invalid.
5. The normal flag-creation route schedules enrichment with Next.js `after()` only after a successful audited creation. Failure cannot undo or turn that successful write into an error. Existing fallbacks remain available; the Audit page supplies an explicit retry path. SDK-key writes and other/new audit producers are not yet automatically enrolled in this hook.

This is best-effort post-response enrichment, not a durable queue or an all-writers batching service. Gemini latency is not claimed to be below five seconds; immediate deterministic fallback avoids blocking the page.

## Digests and access boundaries

- Digests group by actual project/environment IDs and retain source event IDs. Risk ordering is a deterministic review hint based on recorded changes, not an AI prediction of impact.
- Filters and exact inclusive timestamps apply to both the list and digest. Rows are paged at 25; digest composition uses up to the newest 1,000 matching events. Larger results show an explicit coverage warning, including in Markdown. The filter option catalogs are bounded at 1,000 entries each.
- Markdown escapes untrusted labels, HTML, link syntax and control characters. Raw snapshots are not exported.
- `GET /api/audit/overview?workspaceId=...` returns `{ data: { items, pagination, digest } }`. Its query accepts `range`, `projectId`, `flagId`, `actorId`, `environmentId`, `from`, `to`, and `page`. Duplicate/unknown parameters and invalid ranges fail cleanly.
- `POST /api/ai/audit-summary` takes `{ workspaceId, eventIds }`, with 1–20 distinct IDs. Authorization occurs before source lookup/model use and again before publication. Every event lookup/update is workspace-scoped. Responses are private/no-store; errors do not expose provider bodies or database payloads.
- The original Phase 2 `/api/audit` contract remains unchanged.

Configuration stays in Phase 4: `AI_PROVIDER=google`, `AI_MOCK`, `GEMINI_API_KEY`, `LLM_MODEL_FAST`, and `AI_DAILY_WORKSPACE_CALL_LIMIT`. Mock mode bypasses only the provider, not authorization, logging, limits or persistence.

## Verification

- `npm run test:audit`: **56 tests passed** across source grounding, wrong/invented event rejection, runner retry and fast-model selection, digest time boundaries/deduplication/risk ordering, escaped Markdown, API authorization, batch limits, cached reads, filters, safe errors, after-write scheduling, and UI rendering.
- `npm run test:phase2`: **24 passed**, protecting the original flag-create/history contracts.
- `npm run test:ai`: **72 passed**, protecting the shared runner and tools.
- `npm run typecheck`, `npm run contracts:build`, `npm run db:validate`, and scoped Prettier/whitespace checks: **passed**.
- Disposable PostgreSQL 15 integration: all four migrations applied; `tests/audit-store.integration.test.ts` **passed**. It created isolated users/workspaces/events, read an immediate summary in **83 ms**, generated through the real shared runner in mock mode, verified persisted cache/provenance and `AiRun` read-back, verified cache hits avoid a second call, and exercised cross-workspace/viewer rejection. Only its own uniquely named records were removed afterward.
- HTTP smoke on the isolated local dev server: `http://localhost:3008/demo/audit` returned **200**; unauthenticated `/api/audit/overview` returned **401** with a safe error.
- Scoped ESLint timed out after 120 seconds during setup/plugin loading. It is **not** marked passed.
- Production build attempted with `NEXT_BUILD_DIR=node_modules/.cache/phase8-build NEXT_TELEMETRY_DISABLED=1 npm run build -- --no-lint`. It failed outside Phase 8: `packages/evaluator/src/index.ts` could not resolve `./hash.js` and `./evaluate.js`, imported through `lib/sdk-delivery.ts` and `app/api/sdk/events/route.ts`. Lint was explicitly disabled for that build attempt; no successful production build is claimed.

The opt-in database suite is `npm run test:audit:db`. Set `AUDIT_TEST_DATABASE_URL` to a migrated, disposable local database named exactly `flagforge_audit_test`. Without it, the suite is skipped. This session used the local PostgreSQL Unix socket as the `postgres` OS user, without a database password. Never point the suite at application or production data.

## Remaining acceptance work

- Add a durable batching/retry worker and enroll all audit producers, not only successful flag creation. Current explicit enrichment handles batches of up to 20.
- Verify real Gemini output/account access and the authenticated browser flow. SSR tests and HTTP smoke do not prove interactive filtering, keyboard behavior or browser download handling.
- Verify the five-second user-visible target under deployment load. The measured 83 ms is one local fallback observation, not a model latency or production service-level guarantee.
- Apply the new migration to the intended application environment. Finish the live three-change demo and address the unrelated SDK build blocker before deployment.
