# Phase 4: shared AI platform

## Try it

1. Follow the repository's PostgreSQL and GitHub sign-in setup. Run `npm run db:migrate:deploy` and `npm run db:generate` after pulling this change.
2. Keep `AI_MOCK=true` to work without a Gemini key. Start `npm run dev` and open `/ai` after signing in, or choose **AI demo** in the sidebar.
3. Enter a short message and generate a response. The panel shows validated output, the model, mock/live state, run ID, latency, and token counts. Dismiss removes the local preview. Feedback is explicitly local-only; this phase does not persist votes or change flags.
4. For a live check, configure `GEMINI_API_KEY` privately on the server and set `AI_MOCK=false`. Never put the key in browser code or a `NEXT_PUBLIC_` variable. Model selection stays in `LLM_MODEL_FAST` and `LLM_MODEL_REASONING`; only `gemini-*` model IDs and `AI_PROVIDER=google` are accepted.

Mock mode still requires an authenticated workspace and a database. It bypasses only the provider, not authorization, admission control, validation, or logging. The platform test deliberately has no flag data and never claims to inspect or modify flags.

## HTTP contract

`POST /api/ai/test`, same-origin authenticated session, `Content-Type: application/json`:

```json
{ "workspaceId": "your-workspace-id", "message": "Check the AI platform" }
```

The body accepts exactly those fields, with a 4,000-character message limit and a 20,000-byte request limit. Identity is derived from the session, never model/browser-supplied `userId`. Membership is checked before generation and again during atomic run reservation. There is no unauthenticated mock bypass.

Success is `{ "data": { "output": { "message": "...", "insufficientData": true }, "runId": "...", "model": "gemini-2.5-flash", "mock": true, "promptVersion": "1", "tokensIn": 0, "tokensOut": 0, "latencyMs": 10 } }`.

The endpoint uses a server-owned Zod schema, not arbitrary executable schemas supplied over HTTP. Feature code can supply any appropriate Zod output schema through the shared runner. Errors use `{ "error": { "code": "...", "message": "..." } }`, with 400/413 for invalid requests, 401/403 for access, 429 plus `Retry-After` for limits, 502 for invalid provider output, and 503/504 for configuration/unavailability/timeouts. Responses are `no-store`. Provider error bodies and raw invalid output are never returned or logged.

## Integration points

- `lib/ai/runner.ts`: `runAi({ context, prompt, input, logInput, config, store, signal })`. The context must come from trusted authorization. `logInput` is required safe metadata, not raw user messages, credentials, or source snippets.
- `lib/ai/prompts.ts`: typed `AiPrompt`, global guardrails, renderer, and static versioned registry. `prompts/platform-test.v1.ts` is a complete example with system text, user template, output schema name, Zod schema, model tier, and mock fixture. Add future prompts with explicit versions and register their imports.
- `lib/ai/structured.ts`: converts Zod to provider JSON Schema, sanitizes decoded values, then validates. JSON/schema failures include safe validation paths and codes in the one corrective attempt. Sanitization is performed before validation so stripping a string to empty cannot bypass constraints.
- `lib/ai/gemini.ts`: native Gemini REST transport; no provider SDK dependency. Fetch/stream reads are abortable with a 30-second timeout per attempt and a bounded response size. Token usage includes returned candidate and thinking counts when available.
- `lib/ai/store.ts`: Prisma-backed run reservation/finalization, durable admission locks, indexes and logging. `prisma/migrations/20261020040000_ai_platform_usage/migration.sql` preserves historical runs with a nullable `userId` and adds query indexes.
- `lib/ai/tools.ts`: `aiToolRegistry`, `aiToolDefinitions`, and `createAiToolDispatcher({ workspaceId, userId }, prisma)` for all five read-only tools. Every invocation rechecks membership, strictly validates arguments, bounds paging, scopes queries to the workspace, and uses explicit selections. Audit before/after payloads and credentials are excluded. References include authorized source snippets, so later callers must decide what code is appropriate to send to a model.
- `components/ai/`: reusable `AiPanel`, `AiLoading`, `AiError`, and `AiFeedback`. The demo uses Dismiss only because it has no applicable flag change. Future suggestions must require an explicit Apply/confirmation action through normal authorized APIs.

The runner applies global rules to every registered prompt. Feature modules should use the runner rather than calling transports directly, so mock behavior, limits and logging cannot diverge. Phase 5/6/7 adapters developed independently are not automatically rewritten by this phase.

## Retry, streaming and budget semantics

- There are at most **two transport attempts per logical run**, sharing one retry budget between transient network/provider errors and malformed/schema-invalid output. Permanent provider errors and cancellation do not retry. This prevents nested four-call retries.
- `runAi({ streaming: true, onProgress })` consumes native Gemini SSE, including split frames and UTF-8, and validates the full result before returning. Progress exposes only received-character counts, never unsafe partial JSON. The transport also exposes `stream()` for later chat integration. `/api/ai/test` itself returns normal JSON, not a browser SSE stream.
- Each attempt times out after 30 seconds, including response streaming. The route allows 65 seconds; deployment plan limits may still be lower. The UI times out after 90 seconds and prevents duplicate submits.
- The per-user limit is **20 logical runs in a rolling 60-second window across workspaces**. The workspace budget is **200 logical runs per UTC day** by default, configured with `AI_DAILY_WORKSPACE_CALL_LIMIT`. This is a call budget, not a dollar estimate. One admitted run can spend up to two model requests; output tokens per attempt are bounded to 8,192.
- A database transaction takes user/workspace advisory locks, checks membership and both counts using database time, then inserts a `PENDING` run before contacting Gemini. This prevents concurrent overspend across app instances. Mock, failed and pending runs count; denied requests do not create a run or contact Gemini. Restarting the app cannot reset limits.
- Success records sanitized/redacted output, safe input metadata, prompt version, model, latency, and available usage. Failure records a safe code and available usage. Provider calls that fail before reporting usage have unknown consumption represented by zero; this is not exact billing telemetry.
- A database outage fails closed. A process crash can leave a `PENDING` row, which conservatively retains its budget slot. Reconciliation/retention jobs and persisted feedback are future work.

## Verification

Latest local checks (2026-10-20):

| Check                                                            | Result                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:ai`                                                | 72 passed                                                                                                                                                                                                       |
| `AI_TEST_DATABASE_URL=<disposable-local-url> npm run test:ai:db` | PostgreSQL integration: parent plus four subtests passed                                                                                                                                                        |
| `npm run typecheck`                                              | Passed                                                                                                                                                                                                          |
| `npm run db:validate`                                            | Passed                                                                                                                                                                                                          |
| ESLint and Prettier scoped to Phase 4 files; `git diff --check`  | Passed                                                                                                                                                                                                          |
| `npm test`                                                       | All test suites, contracts compilation, Prisma validation and TypeScript completed; the overall command timed out in repository-wide ESLint after 300 seconds. Not a full-suite pass.                           |
| `npm run build`                                                  | Blocked by concurrent Phase 3 work: `packages/evaluator/src/index.ts` cannot resolve `./hash.js` and `./evaluate.js` through the SDK delivery imports. No Phase 4 build error was reported before that failure. |

Offline checks:

```bash
npm run test:ai
npm run typecheck
```

The AI suite covers schema correction and exhaustion, retry ceilings, emoji sequences, Gemini request construction, chunked streaming, cancellation/timeout, provider-safe errors, authenticated HTTP boundaries, mock/live logging, five tools' workspace scoping, and shared UI/client rendering and validation.

The opt-in PostgreSQL integration suite only permits a local database named `flagforge_ai_test`. Apply the migrations to that disposable database, set `AI_TEST_DATABASE_URL` to its connection URL, and run `npm run test:ai:db`. It creates uniquely named fixtures and removes only those fixtures afterward. Without the variable the test is explicitly skipped, not passed against a database.

Verified locally against PostgreSQL 15: all three migrations applied; 25 concurrent admissions across two Prisma clients admitted exactly 20 for one user; users shared a concurrent three-call workspace cap; minute/day expiry worked; foreign members were rejected; mock successes and failed structured generations could be read back from `AiRun` with expected usage.

Not verified: real Gemini account/model access, real GitHub OAuth browser flow, and a deployed live response alongside its run row. Use the steps above to finish that account-dependent demo. No private API key or OAuth credentials were read or changed for these checks.
