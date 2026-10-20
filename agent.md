# FlagForge agent handoff

## Phase 3 update (2026-10-20)

- Implemented independently of the parallel phases: `packages/evaluator/`,
  `packages/sdk/`, `lib/sdk-delivery.ts`, `lib/sdk-store.ts`, the three
  `app/api/sdk/` routes, and `examples/next-app/`.
- `npm run test:phase3`: **61 passed, 0 failed, 0 skipped**. Covers all operators,
  100k-user distribution/stickiness, stream reconnect/poll fallback, ETags,
  resolved-client isolation, hashed telemetry, cancellation, and outage caching.
- Default one-second SSE cadence measured **954.2 ms** from in-memory store change
  to real SDK cache. This excludes dashboard, PostgreSQL, and hosted-network time.
- `npm run sdk:build` and `npm pack --workspace @flagforge/sdk --dry-run --ignore-scripts`
  passed (ESM/CJS/declarations, no runtime dependencies). Not published to npm.
- Targeted Phase 3 ESLint passed before the final cadence test; its final repeat
  timed out at 120 seconds. Phase 3 source formatting passed. Root typecheck passed before concurrent work
  added an unresolved `@/lib/auto-rollout/simulator` import; latest full-tree
  typecheck is blocked there. Do not modify other agents' unfinished files.
- Root `npm test` exceeded 120 seconds at typecheck after its executed test suites
  passed. Root/example builds exceeded 240/180 seconds. No new complete root build
  pass, database-backed integration pass, Docker pass, or deployment is claimed.
- Benchmark median batch averages: **2.145 us** default / **3.933 us** one AND rule /
  **0.544 us** disabled (Node 22.23.3 Linux x64, 100k warmup then 5 x 100k samples).
- Use `npm run example:dev`, then http://localhost:3001. Configure its server key
  with `examples/next-app/.env.example`; never expose a SERVER key to the browser.
- Details and next live verification: [docs/phase3.md](docs/phase3.md). One-second
  database polling observes committed flag changes without a Phase 2 write hook.
  `rules.defaultServe.rolloutPercent` is authoritative; keep the display column
  synchronized when writing. Snapshot versions are equality-only content revisions.
- **Local commits only; the user handles pushes.** No npm publish or remote push
  was attempted for Phase 3. Preserve all other agents' staged/unstaged work.

### Phase 3 next action

After parallel work settles, rerun `npm run test:phase3`, the full `npm test`, and
`npm run build`. Then test an authenticated dashboard toggle against a migrated
database and the example, and stop the control plane to verify cache continuity.
Publishing `@flagforge/sdk` requires authorized npm scope access.

Updated: 2026-10-20
Branch: `main`
Revision: `15233ee feat: complete foundation and workspace access`
Remote: `origin/main` is one commit behind. The implementation is committed locally; do not push until GitHub authentication is configured.

## Phase 2 update

The first flag-management increment is implemented: scoped list/create APIs, safe environment
defaults with an atomic creation audit, and a dashboard create dialog plus detail/history pages.
See [docs/phase2.md](docs/phase2.md) for the current verification evidence and remaining targeting,
confirmation, and archive/restore work. The foundation notes below describe the earlier baseline;
the fixture fallback mentioned there has been removed from authenticated flag loading.

Only commit the intended changes locally. The user handles all pushes.

## Goal

Build FlagForge, a hosted feature-flag control plane. Phase 0 establishes the Next.js shell, PostgreSQL/Prisma schema, seeded demo data, and shared Zod contracts. Phase 1 adds GitHub sign-in, first-login workspace provisioning, role checks, workspace settings/invitations, and SDK key lifecycle management.

## Current state

### Complete locally

- Next.js App Router with TypeScript, Tailwind, Lucide, local Inter and JetBrains Mono fonts, ESLint, Prettier, and standalone production output.
- Light and dark design tokens, responsive shell, sidebar, project/environment controls, theme toggle, command palette stub, loading/empty/toast states, and accessible labels/focus styles.
- Prisma PostgreSQL schema and migration history, including Auth.js adapter models and `WorkspaceInvitation`.
- Deterministic seed data: one workspace, two projects, six environments, 25 flags, 200 audit events, SDK-key fixtures, repository references, and seven days of event data.
- Shared contracts in `packages/contracts/src/index.ts` for rule sets, flags, API envelopes, SDK config/events, and all planned AI outputs.
- Gemini configuration is the app default: `AI_PROVIDER=google`, `GEMINI_API_KEY`, `LLM_MODEL_REASONING=gemini-2.5-pro`, and `LLM_MODEL_FAST=gemini-2.5-flash`.
- Auth.js GitHub provider with database sessions, sign-in page, first-login provisioning, role authorization helpers, member/invitation APIs, and settings UI.
- SDK key APIs and settings UI: cryptographically generated raw key, SHA-256 at-rest hash, one-time secret reveal/copy, metadata-only list, soft revoke, audit events, and `/api/sdk/config` rejection for missing/invalid/revoked keys.
- README, `.env.example`, Dockerfile, migration lock, smoke checks, and seed verification script.

### Incomplete or blocked

- GitHub push is intentionally not done. `git push origin main` failed because the container has no GitHub credentials and `gh` is unavailable. The user will push later.
- No Vercel preview URL exists yet; deployment credentials/project configuration are account-specific.
- No PostgreSQL instance was available in the container, so `npm run db:migrate:deploy`, `npm run db:seed`, and `npm run db:verify` were not run against a real database.
- GitHub OAuth end-to-end, role/API integration tests against a database, and revoked-key curl tests still need real credentials/database setup.
- The root flags page is protected by auth. Without a session it redirects to `/sign-in`; seeded DB data is loaded when the authenticated workspace uses the seeded project, otherwise the deterministic fixture is used.

## Important files

- `plan.md` — source build plan; do not rewrite line endings.
- `README.md` — setup, test, Gemini, deployment, and security notes.
- `app/page.tsx` — authenticated flags page entry point.
- `app/sign-in/` and `auth.ts` — GitHub OAuth flow.
- `app/api/workspaces/[workspaceId]/` — workspace, members, invitations, and SDK key APIs.
- `app/api/sdk/config/route.ts` — bearer SDK-key authentication and config delivery.
- `lib/provisioning.ts` — idempotent first-login workspace/project/environment provisioning and invitation acceptance.
- `lib/workspace-auth.ts` — session, workspace membership, and minimum-role enforcement.
- `components/settings/settings-view.tsx` — workspace/member/invitation/key management UI.
- `prisma/schema.prisma` and `prisma/migrations/` — database contract and migrations.
- `prisma/seed.ts` and `prisma/verify-seed.ts` — deterministic seed and database count verification.
- `packages/contracts/src/index.ts` — runtime Zod schemas and exported TypeScript types.
- `tests/phase0-smoke.ts` — offline contract/fixture smoke test.

## Decisions

- Gemini replaces the plan's original Anthropic provider for future AI phases. Keep model selection in environment variables; do not hard-code API keys.
- SDK authentication uses `Authorization: Bearer <raw-sdk-key>`.
- `SdkKey` stores only `hashedKey` and `prefix`; raw secrets are returned once and excluded from logs/audit events/list responses.
- Workspace authorization happens in route handlers/server helpers rather than edge middleware because checks use Prisma.
- Inviting an existing GitHub user creates an idempotent membership; unknown users receive a pending invitation matched by normalized lowercase username on login.
- `User.githubId` stores the stable provider account ID; `User.githubUsername` is the invitation lookup key.

## Checks

Run from the repository root:

- `npm test` — passed at the current implementation: smoke checks, contracts build, Prisma validation with fallback local URLs, TypeScript, ESLint, and Prettier.
- `npm run build` — passed after the auth/settings/API implementation; Next.js 15.5.6 production build completed and listed all app/API routes. Gemini model-name changes afterward only touched seed fixture strings and environment/docs.
- `npm run test:smoke` — passed: 25 flags, three environments, rule and API contracts parse.
- `npm run db:validate` — passed without a local database because `scripts/db-validate.mjs` supplies placeholder URLs when absent; Prisma emitted only its config deprecation warning.
- `npm run db:verify` — not run; requires a PostgreSQL database populated by `npm run db:seed`.
- Manual production smoke — `/sign-in` responded successfully from `next start` on a temporary local port after the build. The first startup took longer than the initial polling window, so the check eventually succeeded after retries.

## Next step

Set up GitHub authentication and PostgreSQL, then run:

```bash
npm ci
cp .env.example .env
# Fill DATABASE_URL, DIRECT_URL, AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, and Gemini values as needed.
npm run db:generate
npm run db:migrate:deploy
npm run db:seed
npm run db:verify
npm run dev
```

Then verify OAuth provisioning, viewer/admin SDK-key permissions, one-time secret display, active-key `200` config response, and revoked-key `401` response. After that, push the local commit and start Phase 2 from `plan.md`.
