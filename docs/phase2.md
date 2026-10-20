# Phase 2: flag creation and history

Status: the first complete increment is implemented. Phase 2 as a whole is not finished.

## What works

- The authenticated flags page uses the user's actual project, never the demo project or a fixture fallback.
- Server-side search (name, key, description), type and active/archived/all filters, stable sorting, and pagination.
- Create dialog with an editable generated key, type, description, tags, and workspace-member owner.
- Every new flag has one config per actual project environment: disabled, 0% scalar/default rollout, no rules, off `false`, on `true`, version 1.
- Flag, configs, and one `FLAG_CREATED` audit event are committed in one database transaction.
- Flag detail has read-only Targeting and Settings tabs, plus paginated History with actor initials, UTC timestamps, field differences, and expandable JSON.
- Real refresh, request cancellation/race protection, copy-key feedback, retry, skeleton, and empty states.
- Viewers can read; editors, admins, and owners can create. Missing and unauthorized resources both return 404. Owners must belong to the same workspace.

## Try it

Use the setup steps in `README.md` and configure PostgreSQL and GitHub OAuth. No additional Phase 2 environment variables or migration are needed.

1. Sign in and open `/`. A newly provisioned project should be genuinely empty.
2. Choose **Create flag**, enter `Checkout refresh`, and inspect `checkout_refresh`.
3. Add a description, `checkout, web` tags, and a workspace member as owner. Save.
4. Follow the flag name or **View flag** toast link to `/flags/<id>`.
5. Inspect the disabled environments, open **Settings**, then open **History** to see the creation snapshot.
6. Reload and verify the same data persists. Try the duplicate key and verify an inline error without losing the form.
7. With a viewer account, confirm reads work and POST returns 403. With an unrelated workspace account, confirm direct project/flag/history requests return 404.

## API

Success envelopes are `{ "data": ... }`. Errors are `{ "error": { "code", "message", "fieldErrors"? } }`. Responses use `Cache-Control: private, no-store`.

| Method | Route                            | Data                                   |
| ------ | -------------------------------- | -------------------------------------- |
| GET    | `/api/projects/:projectId/flags` | `{ items: FlagSummary[], pagination }` |
| POST   | `/api/projects/:projectId/flags` | `FlagSummary` (201)                    |
| GET    | `/api/flags/:id`                 | `FlagDetail`                           |
| GET    | `/api/audit?flagId=:id`          | `{ items: AuditEvent[], pagination }`  |

The list accepts the existing `listFlagsQuerySchema` contract. `environment` filters flags with a config in that project environment; each returned flag still contains all its project configs. `updatedAt` sorts descending; name/key sort ascending; ID breaks ties. Active flags are the default.

Audit requires `projectId` or `flagId`; additional actor, environment, date, and pagination filters remain inside the authorized project. Conflicting project/flag scopes are rejected. Unknown/repeated query parameters, invalid ranges, and unsafe page offsets return 400. Duplicate keys, including archived keys, return 409 with a key field error.

Server pages use the same authenticated service as the route handlers through `lib/flags.ts`. There is no trusted browser-supplied actor/workspace identity. Database errors are not replaced with demo data.

## Verification

```bash
npm run test:phase2
npm test
npm run build
```

The Phase 2 command runs 24 offline tests in `tests/phase2-backend.ts` and `tests/phase2-ui.ts`:

- Production service and HTTP handlers tested using an injected relational transaction harness: session checks, role policy, workspace/project isolation, safe defaults, owner validation, duplicate keys, filters, pagination, date bounds, request validation, and response shapes.
- Config/audit/commit failure injection verifies no partial flag state is published by the harness.
- Key generation, nested audit diffs, meaningful null/zero/false labels, response validation, field errors, and safe client failure messages.

The UI was also exercised in an isolated browser harness with controlled API fixtures: 69 assertions across creation, errors, refresh, pagination, copying, history, focus, keyboard tabs, and mobile layouts. The app-screen inspector reported zero failures at 1440, 768, and 390 pixels for list/detail, with the prescribed indigo palette allowed. These were one-off component checks, not a committed authenticated end-to-end browser suite.

The shared-workspace `npm test` run reached and passed Phase 2 tests, contracts compilation, Prisma validation, and TypeScript, but failed ESLint on concurrently generated `examples/next-app/.next` files and unrelated example source. Those files were left untouched.

To separate this increment from concurrent work, a clean snapshot of the foundation revision
`23e470a` plus only the Phase 2 changes was verified independently. `npm ci --offline`,
`npm run db:generate`, the complete `npm test`, and `npm run build` all passed in that snapshot.
A production-server smoke check confirmed sign-in redirects for `/` and `/flags/<id>`, and
401/private-no-store responses for unauthenticated list/detail/history/create API requests.
Next.js can send its sign-in redirect as a streaming meta refresh after the loading skeleton.

Live PostgreSQL transaction/concurrency behavior, OAuth sign-in, authenticated browser persistence, and the under-one-second load target remain unverified. The offline harness is not a substitute for those checks.

## Next increment

1. Add audited environment writes with version/conflict handling; keep scalar rollout and `rules.defaultServe.rolloutPercent` consistent. Existing seed data can disagree, so do not silently use one as the other.
2. Add toggles, rollout slider/numeric input, rule construction/reordering, and Production change confirmation.
3. Add metadata updates, archive/restore, and optimistic updates with rollback.
4. Finish tag and On/Off/Partial-rollout filtering; measure load performance against PostgreSQL.

The Phase 2 plan checkboxes remain incomplete wherever the full requirement is not implemented. No deployment or push is part of this increment; the user pushes local commits.
