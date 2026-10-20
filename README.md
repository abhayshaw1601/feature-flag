# FlagForge

FlagForge is a hosted feature-flag control plane for release teams. Phase 0 provides a Next.js shell, a PostgreSQL/Prisma foundation, deterministic seeded data, and shared Zod contracts. Phase 1 adds GitHub authentication, workspace membership, and SDK key management.

## Requirements

- Node.js 22.23.3 (pinned in `.nvmrc`)
- npm 10+
- PostgreSQL 14+
- Git and a GitHub OAuth application for Phase 1

Docker is optional. The included `Dockerfile` builds the Next.js application for a production container, but a PostgreSQL service is still required for database-backed runs.

## Local setup

```bash
cp .env.example .env
npm ci
npm run db:generate
npm run db:migrate:deploy
npm run db:seed
npm run dev
```

Open <http://localhost:3000>.

The default `.env.example` uses a local PostgreSQL database named `flagforge` with user `flagforge` and password `flagforge`. Change `DATABASE_URL` and `DIRECT_URL` when using another database. `DIRECT_URL` may be the same connection string for local PostgreSQL.

The seeded workspace is `Northstar Labs`. It contains two projects, six environments, 25 flags, 200 audit events, SDK-key fixtures, repository references, and seven days of exposure and metric events.

## Checks

The single offline-friendly project check is:

```bash
npm test
```

It runs contract smoke checks, contracts compilation, Prisma schema validation, TypeScript, ESLint, and Prettier. Prisma validation only needs the two URL variables to exist; it does not connect to PostgreSQL.

After a real seed against PostgreSQL, verify the required counts with:

```bash
npm run db:verify
```

For a production build:

```bash
npm run build
npm start
```

## Phase 2 flag creation and history

After signing in, open `/` and choose **Create flag**. Name the flag, review its generated key,
and optionally assign a workspace member, description, and tags. Creation saves the flag with
every project environment disabled at 0% rollout and records one atomic creation audit event.
Open the flag name to view saved targeting, metadata, and its **History** tab. Refresh reads
persisted data; search, type/archive-state filters, sorting, and pagination run on the server.

Viewers can read but cannot create flags. Reads and writes are scoped to workspace membership;
empty projects stay empty instead of displaying demo fixtures. Targeting/metadata edits,
Production confirmation, tag/rollout-state filters, and archive/restore are the next increment.

Run `npm run test:phase2` for 24 offline service, HTTP, and UI-helper tests (included in `npm test`).
These use a transactional database harness, not a live PostgreSQL instance or GitHub OAuth.
See [docs/phase2.md](docs/phase2.md) for the API, verification evidence, and remaining work.

## Phase 1 GitHub OAuth setup

Create a GitHub OAuth App with these callback URLs:

- `http://localhost:3000/api/auth/callback/github`
- `https://<your-deployed-host>/api/auth/callback/github`

Set `AUTH_SECRET`, `AUTH_GITHUB_ID`, and `AUTH_GITHUB_SECRET` in `.env`. The Phase 1 settings and SDK-key APIs also require `DATABASE_URL` and `DIRECT_URL`.

The Phase 4 AI layer uses Gemini only. Set `AI_PROVIDER=google`, `LLM_MODEL_REASONING=gemini-2.5-pro`, and `LLM_MODEL_FAST=gemini-2.5-flash`. `AI_MOCK=true` uses deterministic fixtures without an API key; live mode requires a server-side `GEMINI_API_KEY`. GitHub App variables are reserved for later phases.

## Phase 4 AI platform

Run `npm run db:migrate:deploy` to add AI usage indexes and the run's authenticated user ID, then sign in and open `/ai` (**AI demo** in the sidebar). Generate a response to exercise the schema-validated `/api/ai/test` endpoint and see its run ID, model, token counts, and mock/live label. Nothing changes a flag.

The shared layer includes Gemini structured output and streaming, one retry, versioned prompts, sanitization, workspace-scoped read-only tools, persistent run logging, a rolling 20-call/user/minute limit, and `AI_DAILY_WORKSPACE_CALL_LIMIT` (default 200 calls per UTC day). Limits apply to mock mode too. Existing independently developed feature adapters must adopt `runAi` to inherit these guarantees.

Run `npm run test:ai` for offline regression tests. See [docs/phase4-ai-platform.md](docs/phase4-ai-platform.md) for the API, integration guide, database tests, and remaining live-demo checks.

## Vercel deployment

The app is configured for a standalone Next.js build and can deploy to Vercel with the Vercel CLI or the connected GitHub repository:

```bash
npx vercel
npx vercel --prod
```

Configure the variables from `.env.example` in the Vercel project, add the production GitHub callback URL, and run `npm run db:migrate:deploy` against the hosted PostgreSQL database before opening the preview. A public Vercel preview URL is not committed because deployment credentials and the target Vercel project are account-specific.

## Project structure

- `app/` — Next.js App Router entry points and auth routes
- `components/` — shell, flags, settings, and SDK key UI
- `lib/` — Prisma, authentication, authorization, provisioning, and deterministic fixtures
- `packages/contracts/` — shared Zod schemas and TypeScript types
- `prisma/` — schema, migration, seed, and seed verification
- `tests/` — offline smoke checks

## Security notes

- SDK secrets are generated with cryptographic randomness and stored only as SHA-256 hashes.
- Raw SDK keys are returned once at creation and are never written to audit events.
- Role checks are enforced in route handlers, not only in the UI.
- Never commit `.env` or real credentials.

## Phase 6 rollout risk check

Open `/demo/rollout-risk` for a credential-free confirmation flow: review a Production payments change, see its deterministic HIGH risk, type the flag key, and apply only the first safer step to browser state. No production flag is changed. The authenticated assessment API supports Gemini explanations with a deterministic fallback; production-write integration is still pending.

Run `npm run test:rollout-risk` for the offline safety, provider, cache, and scoped-context checks (included in `npm test`). See [docs/phase6-rollout-risk.md](docs/phase6-rollout-risk.md) for the API, configuration, walkthrough, and remaining integration requirements.

## Phase 7 cleanup preview

The first Phase 7 slice is available at `/demo/cleanup` without credentials: scan a synthetic repository, adjust stale-age thresholds, and preview cleanup diffs. `/repositories` and `/stale-flags` show the same explicitly labelled fixtures after sign-in. No live GitHub or Gemini calls, PR creation, or flag archiving occur yet.

Run `npm run test:cleanup` for the offline scanner, stale detection, safety gate and fixture API tests (also included in `npm test`). See [docs/phase7.md](docs/phase7.md) for the walkthrough, safety boundaries and remaining GitHub integration work.
