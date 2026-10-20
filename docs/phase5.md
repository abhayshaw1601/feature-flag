# Phase 5: natural-language flag drafts

Status: preview flow implemented; **not the complete create-and-save phase**.

## Try it

```bash
npm run dev
```

- Open `http://localhost:3000/demo/flag-creation` for a local fixture demo. It needs no authentication, database, or provider key and never calls the AI endpoint. Choose either example chip, Generate preview, inspect assumptions/targeting, then Edit request or Dismiss.
- On the authenticated Flags page, editors and higher can use the same interface with the current project. Viewers cannot generate. The endpoint remains authenticated even when `AI_MOCK=true`.
- Create is deliberately disabled. The available normal create API creates environments off; saving only metadata would lose the reviewed targeting. Do not replace this with an AI-only write path or silently create a different flag.

## API and context

`POST /api/ai/flag-creation`

```json
{
  "projectId": "project-id",
  "prompt": "Roll out new checkout to 10% of users in India on the pro plan, staging first.",
  "allowProduction": false
}
```

The success envelope is `{ data: { draft, model, mock, previewOnly: true } }`. `draft` uses the actual shared `flagCreationOutputSchema`: `environmentKey` and `rules: { rules, defaultServe }`, rather than the abbreviated JSON sketch in the plan. Errors use `{ error: { code, message } }` and never return raw provider/database details.

Context comes from a membership-scoped project query, not client-supplied keys or attributes. Archived keys are reserved. Without an attribute catalog, known attributes are derived only from saved rules in that project. A fresh project therefore supports unconditional drafts but cannot silently invent `country`, `plan`, or other attributes. Seeded targeting supplies `country` and `plan` for the checkout example.

Production requires both the unchecked-by-default opt-in AND a conservatively recognized affirmative instruction. Mentioning Production, a negative instruction, or "staging first" is not permission. Production key/name aliases are checked server-side. Ambiguous production requests may need rewording. Previewing never modifies flags.

## Provider and fixtures

- `AI_PROVIDER=google`; non-Google providers and non-Gemini model names are rejected.
- `LLM_MODEL_REASONING` defaults to `gemini-2.5-pro`; credentials come only from `GEMINI_API_KEY`.
- Exactly `AI_MOCK=true` enables the ten sentences documented in `lib/flag-creation/fixtures.ts`. Unsupported mock requests return an insufficiency error, not a generic success.
- The versioned prompt is `prompts/flag-creation.v1.ts`. Each real generation has a 30-second total deadline, at most two attempts, bounded provider output, JSON validation, contextual validation, and a display-text sanitizer. Targeting values are never destructively rewritten.
- `lib/flag-creation/generate.ts` is an interim adapter because the shared Phase 4 runner was not available at implementation time. Shared streaming/tools and full cross-feature accounting remain Phase 4 work.

The authenticated endpoint reserves an `AiRun` before generation and records success/failure. It stores request metadata, not raw prompts or credentials. PostgreSQL transaction locks serialize preview reservations: 20 previews per user per minute, and a daily workspace count controlled by `AI_WORKSPACE_DAILY_BUDGET` (default 100; 0 disables generation). Failed/pending/mock runs count toward the cap. This is a request-count cap, not a dollar/token cap. Locks currently coordinate this endpoint only; unify reservations with Phase 4 before claiming a global multi-feature budget. Failed provider-attempt token usage is not fully accounted for by this interim adapter.

## Verification and remaining work

- `npm run test:flag-creation`: 62 offline generator/API/UI-render tests passed, including all ten fixture sentences, auth/access denial, contextual validation, retries, timeouts, production safety, sanitization, error redaction, preview-only response shape, and disabled Create rendering. Render tests do not exercise browser interaction.
- `npm run typecheck`: passed after integration with the concurrently updated Flags page/API signatures.
- `npm run contracts:build` and `npm run db:validate`: passed (schema validation does not connect to PostgreSQL).
- Scoped Prettier checks: passed for the Phase 5 implementation files.
- Scoped ESLint: timed out after 120 seconds during configuration/plugin loading; not claimed passed.
- HTTP smoke: `/demo/flag-creation` returned 200 from the isolated local server at `http://localhost:3005`. The shared `.next` directory initially produced a missing vendor-chunk error; using `NEXT_BUILD_DIR=.next-phase5-preview` isolated this session's preview output without deleting other phases' artifacts.
- Live Gemini quality, PostgreSQL reservation/logging integration, authenticated browser interaction, and production build remain unverified. Ten fixture successes do not establish the plan's 8-of-10 first-attempt live-model target.

Next: use the shared Phase 4 runner once stable; extend/connect the normal Phase 2 create contract to preserve the complete reviewed environment draft with validation and audit; then enable Create and verify persisted read-back. Finally evaluate ten live sentences with recorded semantic correctness and first-attempt results.
