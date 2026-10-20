# Phase 6: rollout risk check

Status: standalone assessment and confirmation slice. Production targeting writes are not connected. The demo never changes a stored flag.

## Try it without credentials

Use the pinned Node version in `.nvmrc`, then:

```bash
npm ci
npm run db:generate
npm run dev
```

Open <http://localhost:3000/demo/rollout-risk>. No database, GitHub sign-in, Gemini key, or `.env` is needed for this fixture route.

1. Keep the payments Production fixture at 5% to 100%.
2. Select **Review rollout risk**. The result must be HIGH.
3. Type `checkout_v2` exactly. Both confirmation actions remain disabled otherwise.
4. Expand **Safer rollout plan** and select **Use this plan**. Only the first step (10% for this fixture) is applied to page state. Later steps are not scheduled.
5. Switch to the payments 0% to 100% fixture: it is HIGH, with a first step of 5%.
6. Switch to Development 10% to 20%: it is LOW and does not require typing a key.
7. Reload to reset. Cancel, error/retry, loading, and expired-assessment states never save anything.

The screen retains the existing FlagForge tokens and fonts. Its main comparison is the proposed default serve against the current one; these are configuration percentages, not measured audience sizes. Sample keys `checkout_v2` and `dashboard_v2` are fixtures, not claims about a user's workspace.

## Implemented

- Pure deterministic checks cover production, default and per-rule jumps, enabling disabled flags, all-users targeting, sensitive tags, structural rule changes, and edits by other/unknown actors within 15 minutes.
- Production payments 0% to 100% is always HIGH. Ordinary Development 10% to 20% is LOW. Rules have separate serve caps; the largest cap is never described as measured audience size.
- Gemini-only adapter uses the configured reasoning model, schema validation, one retry, a versioned prompt, and emoji/text normalization. Each attempt has a 1.5-second deadline including body reads. Failure returns explicitly labeled deterministic guidance, not an invented successful AI response.
- The model cannot lower any deterministic risk floor. Unsafe, descending, out-of-range, or overly aggressive plans are replaced with bounded deterministic steps.
- Process-local 60-second cache includes workspace, actor, flag/environment version, complete change, recent edits, model, mode, and prompt version. Identical in-flight calls are coalesced; cached responses retain their original expiry.
- Reusable native dialog supports cancellation, focus restoration, exact-key HIGH confirmation, stale-response rejection, expiry, retry, and first-step-only application preserving targeting conditions.
- Authenticated assessments load authoritative before state, tags, environment, version, and recent audit events from the scoped database. Viewer, cross-workspace, inconsistent-data, and stale-version requests fail closed.
- Each uncached authenticated assessment records an `AiRun`. Input logging uses a change pointer instead of raw targeting values. Provider errors and credentials are not logged or returned.

## API and configuration

`POST /api/ai/rollout-risk/demo` accepts the fixture `RolloutRiskInput` defined in `lib/rollout-risk/types.ts` and always uses deterministic mock mode. It is public, bounded to a 64 KiB request, and never touches the database or Gemini. The demo shares a process-local 20-uncached-changes/minute limit; cache hits do not consume it.

`POST /api/ai/rollout-risk` requires an authenticated editor/admin/owner. Its strict body is:

```json
{
  "flagId": "a-real-flag-id",
  "environmentId": "an-environment-in-that-project",
  "expectedVersion": 1,
  "after": {
    "enabled": true,
    "rolloutPercent": 100,
    "rules": { "rules": [], "defaultServe": { "rolloutPercent": 100 } }
  }
}
```

The response is `{ data: { assessment, source, model, notice, assessedAt, expiresAt, cached } }`. `source` is `mock`, `gemini`, or `fallback`. HTTP responses are `no-store`; caching is server-side and scoped.

For live explanations, configure existing `.env.example` variables: `AI_PROVIDER=google`, `AI_MOCK=false`, `GEMINI_API_KEY`, and `LLM_MODEL_REASONING` (default `gemini-2.5-pro`). This route also needs the normal Auth.js and database configuration. `AI_WORKSPACE_DAILY_BUDGET` defaults to 200 uncached live assessment attempts per UTC day. One assessment can make up to two provider requests. Rate limiting is 20 uncached assessments/user/minute.

## Safety and remaining integration

This API is advisory, not a write authorization token. A future production mutation handler must reload current state, validate the expected version, recompute the floor, enforce the typed key server-side for HIGH, and persist the chosen first step with an audit event in one transaction. A UI-only key check is not sufficient for real writes.

The Phase 4 shared client/store was unavailable when this slice started. The small feature-local Gemini adapter is replaceable; it does not implement the whole AI platform. Cache and rate/budget stores are process-local, bounded, and reset on restart. Move these to a shared durable store before multi-instance production deployment; the current daily cap is not a global billing guarantee.

The 3-second provider budget leaves time for UI updates, but does not guarantee end-to-end latency under slow database access, cold starts, or network delays. Measure the real authenticated path before claiming the plan's under-4-second production criterion. A fallback assessment does not prove that live Gemini succeeded.

Structural targeting changes are intentionally conservative and can over-classify a narrowing change. Applying a shared first-step cap may reduce an existing higher-percentage branch. Hold/watch text remains advice, not automated monitoring.

## Verification

```bash
npm run test:rollout-risk
npm test
npm run build
```

The focused suite is offline: deterministic boundaries, first-step preservation, sanitization, provider retries/timeouts, cache TTL/isolation, budgets, input bounds, and scoped context loading with fake database delegates. It does not replace integration testing against PostgreSQL and a real GitHub session.

The existing Dockerfile and Vercel setup in `README.md` apply unchanged. No new runtime dependency, schema migration, or system package is required by Phase 6.

### Local check record (2026-10-20)

- Focused suite: 38 tests passed, including the deterministic boundary matrix.
- Root TypeScript check passed. File-scoped ESLint and Prettier checks passed for Phase 6.
- Real Next.js demo HTTP smoke passed: Production payments HIGH, Development LOW, and anonymous access to the authenticated route returned 401. One warmed, uncached mock request took 428 ms locally; this is not a live Gemini or deployment latency measurement.
- Chromium interaction checks passed: exact-key gating, first-step 5% to 10%, LOW confirmation, focus restoration, error/retry, expiry, Escape, loading cancellation, and no runtime exceptions.
- Browser inspection at 1440, 768, and 390 pixels reported zero failures. The one canvas warning assumes a sidebar; this standalone demo instead has a centered canvas with equal 152px desktop margins. Screenshots were reviewed in light and dark mode. The comparison stays readable, zeros remain explicit, and no horizontal overflow was observed. Long assessments scroll within the dialog on small screens.
- `npm test` reached root lint after passing its test/type/schema steps, but the overall run did not complete cleanly. A separate root lint run reported generated files under `examples/next-app/.next/` and concurrent example-source errors, outside Phase 6. Do not treat the repository-wide check as passed.
- The initial `npm run build` attempt timed out during production compilation at five minutes. No successful production build, live Gemini call, or real PostgreSQL/session integration is claimed by this record.
