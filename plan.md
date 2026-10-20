# FlagForge: Hosted Feature Flag Platform with AI

Build plan for the Omnirush hackathon. FlagForge is a working name; rename freely.

A hosted feature flag platform where teams sign in with GitHub, manage flags in a clean dashboard, and evaluate them locally through an SDK. Eight AI features sit on top to make rollouts safer and flag hygiene automatic.

---

## 1. How to use this plan

- Every phase is independent. Each one lists what it needs, what it builds, and how to demo it on its own.
- Phases never import each other's code. They talk through the shared contracts in Phase 0 (database schema, API shapes, AI output schemas). Where a phase would normally depend on another, it ships with a fixture or mock so you can build and demo it alone.
- Phases 1 to 3 are the platform. Phase 4 is the shared AI layer. Phases 5 to 12 are the eight AI features, one per phase. Phase 13 is polish.
- Two or more people can run phases in parallel once Phase 0 is merged.

### Priority tiers (use as your cut line if time runs short)

| Tier | Phases | Meaning |
|---|---|---|
| Must | 0, 1, 2, 3, 4, 5, 6 | Working product plus the two easiest AI wins |
| Should | 7, 8, 13 | GitHub PR automation, audit summaries, polish |
| Stretch | 9, 10, 11, 12 | Auto-rollback, impact analysis, experiments, chat |

### Time estimates

Estimates assume one focused developer. Total is about 60 to 70 hours. For a 36 to 48 hour hackathon with 2 to 3 people, build all Must and Should phases and as many Stretch phases as fit.

| Phase | Name | Hours |
|---|---|---|
| 0 | Foundation and contracts | 4 |
| 1 | Auth, workspaces, SDK keys | 5 |
| 2 | Flag management and dashboard | 8 |
| 3 | Evaluation engine, SDK, delivery | 7 |
| 4 | AI platform layer | 4 |
| 5 | AI 1: Natural-language flag creation | 4 |
| 6 | AI 2: Rollout risk check | 4 |
| 7 | AI 3: Stale flag cleanup and PR generation | 7 |
| 8 | AI 4: Plain-English audit summaries | 3 |
| 9 | AI 5: Auto-rollback and auto-ramp | 7 |
| 10 | AI 6: Flag impact analysis | 5 |
| 11 | AI 7: Experiment analysis | 5 |
| 12 | AI 8: Chat assistant over flags | 5 |
| 13 | Polish, demo, resume | 5 |

---

## 2. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js (App Router) with TypeScript | One repo for UI and API routes |
| Styling | Tailwind CSS with shadcn/ui components | Fast, consistent, accessible |
| Icons | Lucide (SVG icon set) | Consistent line icons, no emoji |
| Fonts | Inter for UI, JetBrains Mono for keys and code | Clean and readable |
| Database | PostgreSQL (Neon or Supabase) with Prisma | Typed schema, easy migrations |
| Auth | Auth.js (NextAuth) with GitHub provider | GitHub login in minutes |
| GitHub automation | GitHub App via Octokit | Repo scanning and PR creation |
| Realtime | Server-Sent Events from a Next.js route | Simple live flag updates |
| LLM | Anthropic Claude API | Strong structured output and tool use |
| Validation | Zod | Shared schemas for API and AI outputs |
| Charts | Recharts | Metrics and experiment views |
| SDK | TypeScript package (`@flagforge/sdk`) | Local evaluation, zero dependencies |
| Hosting | Vercel for the app, Neon for the database | Free tiers, fast deploys |

Model configuration lives in environment variables so you can swap models without code changes:

```
LLM_MODEL_REASONING=<larger model, used for creation, risk, impact, experiments, chat>
LLM_MODEL_FAST=<smaller model, used for summaries and classification>
```

---

## 3. Architecture overview

```
Browser (dashboard)  ->  Next.js API  ->  PostgreSQL
                            |
                            +->  Delivery (config endpoint + SSE stream)  ->  SDK inside customer app
                            +->  AI layer  ->  LLM API
                            +->  GitHub App  ->  customer repositories
                            +->  Ingest API  <-  SDK (exposure events, metrics)
```

- Control plane: dashboard, flag API, audit log, AI features.
- Data plane: config delivery, SDK evaluation, event ingest.
- Evaluation is always local in the SDK. The server never evaluates per request.

---

## 4. UI and design rules (apply to every phase)

The interface must look like a finished product, not a hackathon prototype.

### Hard rules

1. No emojis anywhere. This covers UI copy, buttons, toasts, empty states, AI responses, README, commit messages, and seed data.
2. Use Lucide SVG icons only, at consistent sizes (16px inline, 20px in navigation, 24px max in empty states).
3. Status is shown with text labels plus a small colored dot drawn in CSS, never with symbols or emoji.
4. AI output is sanitized before display. The system prompt for every AI call says "Do not use emojis", and a server-side filter strips any emoji characters from model output as a backstop.
5. only use gemini models for ai features.
6. a server is running on localhost:3000, do not start it again. if it is not running or needed then start it.

### Design tokens

| Token | Light | Dark |
|---|---|---|
| Background | #FFFFFF | #0B0D12 |
| Surface | #F7F8FA | #12151C |
| Border | #E4E7EC | #232733 |
| Text primary | #101828 | #F2F4F7 |
| Text secondary | #667085 | #98A2B3 |
| Accent | #4F46E5 | #818CF8 |
| Success | #12B76A | #32D583 |
| Warning | #F79009 | #FDB022 |
| Danger | #F04438 | #F97066 |

- Radius: 8px for controls, 12px for cards.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48.
- Type scale: 12, 14 (default body), 16, 20, 24, 32. Weights 400 and 500 only.
- Borders are 1px hairlines. No heavy shadows. One subtle shadow allowed on popovers.
- Support light and dark mode from day one using CSS variables.

### Layout

- Left sidebar (240px): workspace switcher, Flags, Experiments, Audit log, Assistant, Repositories, Settings.
- Top bar: project switcher, environment switcher (Development, Staging, Production) shown as a segmented control, user menu.
- Content area: max width 1200px, 24px padding.
- Command palette (Cmd+K) to jump to any flag.

### Required states for every screen

- Loading: skeleton placeholders, never a bare spinner on a blank page.
- Empty: one line explaining the screen, one primary action button, a simple Lucide icon.
- Error: inline message with a retry action.
- Success: toast in the bottom right, auto-dismiss in 4 seconds.

### Accessibility

- Visible keyboard focus rings, labels on all inputs, color contrast of at least 4.5 to 1, icon-only buttons have `aria-label`.

---

## 5. Phase 0: Foundation and contracts

Goal: a deployed skeleton plus the shared contracts that let every later phase be built independently.

Depends on: nothing.

### Tasks

- [ ] Create the repo, set up Next.js, TypeScript, Tailwind, shadcn/ui, ESLint, Prettier.
- [ ] Install Lucide, Inter, and JetBrains Mono. Define design tokens as CSS variables.
- [ ] Build the app shell: sidebar, top bar, environment switcher, theme toggle, command palette stub.
- [ ] Set up Prisma with the schema below and run the first migration.
- [ ] Write a seed script with realistic data: 1 workspace, 2 projects, 3 environments each, 25 flags with varied states, 200 audit events, 7 days of metric events. No emojis in seed text.
- [ ] Create a `/packages/contracts` folder (Zod schemas and TypeScript types) for flags, rules, AI outputs, and API shapes.
- [ ] Deploy to Vercel with a preview URL.
- [ ] Add a `.env.example` listing every variable.

### Shared database schema

```
User(id, githubId, name, email, avatarUrl)
Workspace(id, name, slug)
Member(id, workspaceId, userId, role)                 role: OWNER | ADMIN | EDITOR | VIEWER
Project(id, workspaceId, name, key)
Environment(id, projectId, name, key)                 e.g. development, staging, production
SdkKey(id, environmentId, type, hashedKey, prefix)    type: SERVER | CLIENT
Flag(id, projectId, key, name, description, type, tags, ownerId, archivedAt, createdAt)
                                                      type: RELEASE | OPS | EXPERIMENT | PERMISSION
FlagEnvironment(id, flagId, environmentId, enabled, rules JSON, rolloutPercent, offValue, onValue, version)
AuditEvent(id, projectId, flagId, environmentId, actorId, action, before JSON, after JSON, createdAt)
ExposureEvent(id, environmentId, flagKey, variation, userHash, createdAt)
MetricEvent(id, environmentId, flagKey, variation, metric, value, createdAt)
Repository(id, workspaceId, githubRepoId, fullName, installationId)
FlagReference(id, repositoryId, flagKey, filePath, line, snippet, lastSeenAt)
Experiment(id, flagId, name, primaryMetric, status, startedAt, endedAt)
AiRun(id, workspaceId, feature, input JSON, output JSON, model, latencyMs, tokensIn, tokensOut, createdAt)
ChatThread(id, workspaceId, userId, createdAt)
ChatMessage(id, threadId, role, content, toolCalls JSON, createdAt)
```

### Shared rule schema (used by the dashboard, SDK, and AI)

```json
{
  "rules": [
    {
      "id": "rule_1",
      "description": "India users on the pro plan",
      "conditions": [
        { "attribute": "country", "operator": "equals", "values": ["IN"] },
        { "attribute": "plan", "operator": "equals", "values": ["pro"] }
      ],
      "serve": { "rolloutPercent": 10 }
    }
  ],
  "defaultServe": { "rolloutPercent": 0 }
}
```

Supported operators: `equals`, `not_equals`, `in`, `not_in`, `contains`, `starts_with`, `greater_than`, `less_than`.

### Shared API contract

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/projects/:p/flags` | List flags |
| POST | `/api/projects/:p/flags` | Create flag |
| GET | `/api/flags/:id` | Flag detail with per-environment config |
| PATCH | `/api/flags/:id/environments/:e` | Update enabled, rules, rollout |
| DELETE | `/api/flags/:id` | Archive flag |
| GET | `/api/audit` | List audit events |
| GET | `/api/sdk/config` | SDK config (auth by SDK key) |
| GET | `/api/sdk/stream` | SSE stream of config changes |
| POST | `/api/sdk/events` | Ingest exposure and metric events |
| POST | `/api/ai/:feature` | Run an AI feature |

### Acceptance criteria

- App is deployed, shell renders in light and dark mode, seed data loads.
- Another developer can clone the repo and run it in under 5 minutes.
- Contracts package builds and is imported by the app.

### Demo on its own

Show the empty shell with navigation, theme toggle, and seeded database in a table viewer.

---

## 6. Phase 1: Auth, workspaces, and SDK keys

Goal: users sign in with GitHub, belong to a workspace, and can generate SDK keys.

Depends on: Phase 0 schema only.

### Tasks

- [ ] Configure Auth.js with the GitHub provider and database sessions.
- [ ] Sign-in page: product name, one line of value text, a single "Continue with GitHub" button using the GitHub logo SVG.
- [ ] First-login flow: create a workspace named after the user, create a default project and three environments.
- [ ] Role checks in API middleware (OWNER, ADMIN, EDITOR, VIEWER).
- [ ] Settings page: workspace name, members list, invite by GitHub username.
- [ ] SDK keys screen: per environment, create and revoke keys, show the full key once, then only the prefix. Keys displayed in the mono font with a copy button.
- [ ] Hash keys at rest (SHA-256). Never log raw keys.

### UI notes

- Sign-in page is centered, 400px card, plenty of whitespace.
- Keys table columns: Name, Type, Environment, Prefix, Created, Last used, Revoke.
- Revoke uses a confirmation dialog that names the key.

### Acceptance criteria

- GitHub login works on the deployed URL.
- A viewer cannot create keys; an admin can.
- A revoked key is rejected by `/api/sdk/config`.

### Demo on its own

Sign in with GitHub, land in a fresh workspace, create a Production server key, copy it.

---

## 7. Phase 2: Flag management and dashboard

Goal: full flag lifecycle through a polished UI with an audit trail.

Depends on: Phase 0 schema. Uses a hardcoded user if Phase 1 is not merged.

### Tasks

- [ ] Flags list page: table with columns Name and key, Type, Status per environment, Rollout, Owner, Updated. Search, filter by type, tag, and status, sort, and pagination.
- [ ] Create flag dialog: name, auto-generated key (editable), type, description, tags, owner.
- [ ] Flag detail page with three tabs: Targeting, History, Settings.
- [ ] Targeting tab: toggle per environment, rollout percentage slider with numeric input, rule builder (add condition, pick attribute, operator, values), rule reordering by drag handle.
- [ ] Production changes require a confirmation dialog that summarizes the change.
- [ ] Every write creates an `AuditEvent` with before and after JSON.
- [ ] History tab: timeline of audit events with actor avatar, action, and a before/after diff view.
- [ ] Archive and restore flags.
- [ ] Optimistic UI with rollback on error.

### UI notes

- Status cell: colored dot plus text (On, Off, Partial rollout).
- Rollout cell: thin progress bar with the percentage.
- Rule builder rows align on one line at desktop width and stack on mobile.
- Provide a "Copy flag key" button next to the key.

### Acceptance criteria

- A flag can be created, targeted, toggled, and archived without leaving the dashboard.
- Each change appears in History with a readable diff.
- Page loads in under 1 second with 25 seeded flags.

### Demo on its own

Create a flag, add a rule for India users, set 10 percent rollout in Staging, show the diff in History.

---

## 8. Phase 3: Evaluation engine, SDK, and delivery

Goal: apps evaluate flags locally with the SDK and receive updates within seconds.

Depends on: Phase 0 schema. Can use seeded flags if Phase 2 is not merged.

### Tasks

- [ ] Build the evaluation engine as a pure function in `/packages/evaluator`, with no network or database access.
- [ ] Sticky bucketing: `bucket = hash(flagKey + ":" + userId) mod 10000`, enabled when `bucket < rolloutPercent * 100`. Use a stable hash such as murmur3.
- [ ] Rule evaluation: first matching rule wins, then default serve. Missing attributes never throw.
- [ ] `/api/sdk/config`: returns the full flag set for the environment of the SDK key. Supports ETag and 304 responses.
- [ ] `/api/sdk/stream`: SSE endpoint that pushes a version bump when a flag changes.
- [ ] Publish `@flagforge/sdk` for Node and browser: `init`, `isEnabled(key, user, fallback)`, `getValue`, `onChange`, `close`.
- [ ] SDK keeps config in memory, falls back to polling every 30 seconds if SSE drops, and returns the supplied fallback if config never loaded.
- [ ] SDK batches exposure events and posts them to `/api/sdk/events` every 10 seconds.
- [ ] Client-type keys receive only resolved values for the supplied user context, never raw rules.
- [ ] Write a small example app (Express or Next.js) in `/examples` that uses the SDK.
- [ ] Unit tests: bucketing distribution (within 1 percent of target across 100k users), stickiness, rule operators.
- [ ] Micro benchmark of evaluation latency. Record the number for your resume.

### Acceptance criteria

- Changing a flag in the dashboard reaches the example app in under 3 seconds.
- Killing the server does not break the example app; it keeps serving cached values.
- Same user gets the same result across runs. Raising 10 percent to 50 percent keeps the original 10 percent enabled.

### Demo on its own

Run the example app, toggle a flag in the dashboard, watch the example app change live.

---

## 9. Phase 4: AI platform layer

Goal: one reusable layer that every AI feature calls, so features stay small and consistent.

Depends on: Phase 0 contracts.

### Tasks

- [x] LLM client wrapper with model selection, timeouts (30 seconds), one retry, and streaming support.
- [x] Structured output helper: every call provides a Zod schema, the model returns JSON, the server validates it, and retries once with the validation error on failure.
- [x] Prompt registry: prompts stored as versioned files in `/prompts`, each with a system prompt, a user template, and the output schema name.
- [x] Global system rules added to every prompt: no emojis, plain professional tone, never invent flag keys, say when data is insufficient.
- [x] Output sanitizer: strips emoji characters and trims whitespace.
- [x] Tool definitions for later features: `list_flags`, `get_flag`, `get_audit_events`, `get_metrics`, `get_references`.
- [x] `AiRun` logging for every call (feature, input, output, latency, tokens).
- [x] Rate limit: 20 AI calls per user per minute. Daily workspace budget cap from an env variable.
- [x] Mock mode: `AI_MOCK=true` returns fixture outputs so UI work never blocks on the API.
- [x] Shared UI components: `AiPanel` (card with a "Generated" label and model note), `AiLoading` (skeleton with progress text), `AiError`, `AiFeedback` (thumbs up and down using Lucide icons).

Local implementation: `/ai` and `/api/ai/test`; see `docs/phase4-ai-platform.md` for checks and integration details. Limits and logging apply through the shared runner; independently developed feature adapters still need to adopt it. Daily budget is a logical-call cap, not a dollar estimate. Live Gemini, GitHub OAuth browser verification, and deployment remain pending.

### UI notes

- AI content always sits in a clearly labeled panel with a thin accent border, so users know what is generated.
- Every AI suggestion has an explicit Apply or Dismiss action. AI never changes data without a confirmation click.

### Acceptance criteria

- Calling `/api/ai/test` with a schema returns validated JSON.
- Invalid model output triggers one retry, then a clean error state.
- Emoji characters in a test string are stripped.

### Demo on its own

Show the `AiPanel` with mock mode on, then flip to live mode and show a real validated response and its `AiRun` row.

---

## 10. Phase 5: AI 1, Natural-language flag creation

Goal: type a sentence, get a ready-to-review flag.

Depends on: Phase 4. Uses the Phase 0 flag and rule schemas. Works without Phase 2 by showing the preview only.

### Behavior

Input: "Roll out new checkout to 10% of users in India on the pro plan, staging first."

Output (validated):

```json
{
  "key": "new_checkout",
  "name": "New checkout",
  "type": "RELEASE",
  "description": "Gradual rollout of the redesigned checkout flow.",
  "environments": [
    { "environment": "staging", "enabled": true, "rules": [ ... ], "defaultRolloutPercent": 0 }
  ],
  "assumptions": ["Interpreted 'staging first' as Staging only; Production left off."],
  "warnings": []
}
```

### Tasks

- [x] Prompt that receives the project's existing flag keys, known user attributes, and environments, so it avoids duplicate keys and uses real attributes.
- [x] Prompt rule: if the request is ambiguous, put the interpretation in `assumptions` instead of guessing silently.
- [x] UI: a command bar at the top of the Flags page ("Describe a flag in plain English") with example chips such as "Kill switch for payments".
- [x] Preview drawer: shows the flag as the dashboard would render it, with assumptions listed above Create and Edit buttons.
- [ ] Create button posts through the normal Phase 2 API, so audit and validation still apply.
- [x] Reject output that references unknown attributes or invalid operators (server-side validation).

Progress (2026-10-20): preview-only flow implemented, including `/api/ai/flag-creation` and a credential-free fixture demo at `/demo/flag-creation`. Create stays disabled until generated environment targeting is integrated with the normal audited API. Gemini uses a replaceable Phase 5 adapter pending the shared Phase 4 runner. Ten deterministic fixtures and safety/API tests are not evidence of live-model accuracy; the 8-of-10 live acceptance check remains open. Details and checks: `docs/phase5.md`.

### Acceptance criteria

- At least 8 of 10 test sentences produce a valid, correct flag on the first try.
- Output always passes the rule schema or shows a clean error.
- Production is never enabled unless the user explicitly asked for it.

### Demo on its own

Type one sentence, review the preview, click Create, show the new flag in the list.

---

## 11. Phase 6: AI 2, Rollout risk check

Goal: before a risky change is saved, show a risk assessment and a safer plan.

Depends on: Phase 4. Uses a proposed change (before and after JSON) as input, so it works without live data.

### Behavior

Triggered when a user edits Production targeting. Returns:

```json
{
  "riskLevel": "LOW | MEDIUM | HIGH",
  "reasons": ["Rollout jumps from 5% to 100% in one step.", "Flag is tagged 'payments'."],
  "saferPlan": [
    { "step": 1, "rolloutPercent": 5, "hold": "30 minutes", "watch": "error rate" },
    { "step": 2, "rolloutPercent": 25, "hold": "1 hour", "watch": "error rate, latency" }
  ],
  "missingSafeguards": ["No kill switch flag linked."]
}
```

### Tasks

- [ ] Deterministic pre-checks in code first (percentage jump size, all-users target, production, sensitive tags, recent change by another user). Pass findings to the model as facts.
- [ ] The model explains, ranks, and writes the safer plan. It never lowers a risk level that deterministic checks marked HIGH.
- [ ] UI: the Production confirmation dialog from Phase 2 gains a risk panel with a level badge (text plus colored dot), reasons list, and a collapsible safer plan with a "Use this plan" button that saves the first step only.
- [ ] HIGH risk requires typing the flag key to confirm.
- [ ] Cache the assessment for 60 seconds per unique change.

### Acceptance criteria

- A 0 to 100 percent change in Production on a payments-tagged flag is always HIGH.
- A 10 to 20 percent change in Development is LOW.
- Response appears in under 4 seconds, with the dialog usable while loading.

### Demo on its own

Change a payments flag from 5 to 100 percent, show HIGH risk, apply the safer plan.

---

## 12. Phase 7: AI 3, Stale flag cleanup and PR generation

Goal: find dead flags in the user's GitHub repos and open a pull request that removes them.

Depends on: Phase 1 GitHub identity and Phase 4. Ships with a fixture repository scan so the UI works before the GitHub App is wired.

### Tasks

- [ ] Create a GitHub App with permissions: Contents (read and write), Pull requests (read and write), Metadata (read). Users install it on chosen repositories.
- [ ] Repositories page: connect repositories, show last scan time and flag reference count.
- [ ] Scanner: walks the repo through the GitHub API, finds SDK calls (`isEnabled("key"`, `getValue("key"`) with regex plus language-aware patterns, and stores `FlagReference` rows.
- [ ] Stale detection: a flag is a cleanup candidate when it is on at 100 percent in all environments for 30 days or more (configurable), or off everywhere for 60 days or more, and has code references.
- [ ] AI step: for each candidate, send the surrounding code of every reference to the model. It returns the edited file contents with the dead branch removed, plus an explanation and a confidence score.
- [ ] Safety: if confidence is below 0.8 or the file changes by more than 40 lines, mark as "Needs manual review" and do not open a PR.
- [ ] PR creation: new branch `flagforge/cleanup-<flagKey>`, one commit per file, PR body with the explanation, the list of files changed, and a link back to the flag.
- [ ] Stale flags page: list of candidates with reason, days stale, reference count, and a "Generate cleanup PR" button. Shows a diff preview before the PR is opened.
- [ ] After PR merge (webhook), archive the flag.

### Acceptance criteria

- On a demo repo with 3 stale flags, the system opens 3 correct PRs that pass the repo's existing build.
- No PR is opened for low-confidence changes.

### Demo on its own

Open the Stale flags page, preview the diff for one flag, click Generate, show the real PR on GitHub.

### Implementation progress (2026-10-20)

Phase 7 has started with the fixture-first slice; the live integration tasks above are not yet complete. Details and next steps: `docs/phase7.md`.

- [x] Pure JS/TS reference scanner with line numbers and surrounding context, exercised against a fixture repository.
- [x] Conservative stale detection with configurable 30-day ON / 60-day OFF thresholds and full environment coverage checks.
- [x] Schema-validated cleanup review, trusted-source diffs, confidence and per-file changed-line safety gates.
- [x] Repository and stale-flag fixture screens, search, thresholds, loading/error/empty states, and explicit diff preview.
- [x] Public standalone fixture demo at `/demo/cleanup`, including a low-confidence manual-review case; offline tests in `npm run test:cleanup`.
- [ ] Live GitHub installation, API scanning and persisted references; Gemini-generated edits through Phase 4.
- [ ] Reviewed/idempotent PR creation, verified merge webhook and audited archive, and the three-real-PR acceptance demo.

---

## 13. Phase 8: AI 4, Plain-English audit summaries

Goal: turn raw audit events into readable sentences and daily digests.

Depends on: Phase 4 and AuditEvent data. Works on seeded audit events.

### Tasks

- [x] Per-event summary: "Priya raised checkout_v2 in Production from 10% to 50%." Generated by the fast model with before and after JSON.
- [ ] Batch and cache summaries on write, stored with the event so the page never waits on the model.
- [x] Digest: "What changed" for the last 24 hours or 7 days, grouped by project and environment, highlighting risky changes first.
- [x] Audit log page: filter by flag, actor, environment, and date range. Each row shows the summary with a "View raw diff" expander.
- [x] Digest card at the top of the Audit page and as a dashboard widget.
- [x] Export digest as Markdown.

Progress (2026-10-20): authenticated `/audit`, a dashboard widget, and a credential-free `/demo/audit` are implemented. The Phase 4 fast-model runner selects only sentences supported by validated before/after facts; digests are composed from source-linked summaries. Batches of up to 20 are persisted with provenance. Flag creation schedules best-effort after-response enrichment; automatic batching across every audit writer and durable retry are still open. Immediate fallback read-back measured 83 ms in a disposable PostgreSQL test, not a live-model/deployment latency guarantee. Migration and verification details: `docs/phase8.md`.

### Acceptance criteria

- Every audit row shows a summary within 5 seconds of the change.
- Digest never mentions a change that is not in the audit log.

### Demo on its own

Make three changes, open the Audit page, show summaries and the generated digest.

---

## 14. Phase 9: AI 5, Auto-rollback and auto-ramp

Goal: watch metrics after a rollout; disable the flag if it harms the product, or advance the rollout if it is healthy.

Depends on: Phase 3 ingest API (or a simulator) and Phase 4. Includes a metrics simulator so it runs standalone.

### Tasks

- [ ] Metrics ingest: error rate, latency p95, conversion, per flag and variation, stored as `MetricEvent`.
- [ ] Simulator script and a "Simulate traffic" button in the demo environment, with a "Inject errors" toggle that makes the enabled variation degrade.
- [ ] Guardrail definition per flag: metric, threshold, comparison window (for example, error rate must not exceed baseline by more than 2 percentage points for 5 minutes).
- [ ] Monitor job (cron or a polling worker every 30 seconds): compares the enabled variation against baseline using a simple statistical check (two-proportion z-test for rates, relative change for latency).
- [ ] Decision engine: ROLLBACK, HOLD, or ADVANCE. Statistics decide; the model only explains the decision and drafts the incident note.
- [ ] Ramp policy: user-defined steps (for example 5, 25, 50, 100) with hold times. ADVANCE moves to the next step only after the hold time passes with healthy metrics.
- [ ] Rollback action: set the flag off in that environment, write an audit event with actor "FlagForge Guard", and send a notification (in-app, optional webhook).
- [ ] Rollout page: live chart of baseline versus enabled variation, current step, next decision time, and a plain-English status line. Manual override buttons: Pause, Roll back now, Advance now.
- [ ] Opt-in per flag, off by default.

### Acceptance criteria

- With the simulator injecting errors, the flag is rolled back within 2 monitoring cycles and the explanation names the metric that breached.
- With healthy traffic, a 4-step ramp completes on schedule (accelerated timers in demo mode).

### Demo on its own

Start a ramp, click "Inject errors", watch the chart diverge and the flag turn off with an explanation.

---

## 15. Phase 10: AI 6, Flag impact analysis

Goal: show which services and files a flag touches, so reviewers know the blast radius.

Depends on: Phase 4 and `FlagReference` data (from Phase 7 scanner or fixtures).

### Tasks

- [ ] For a chosen flag, gather every reference with surrounding code (30 lines of context each).
- [ ] Model returns: affected components, what behavior changes when on versus off, user-facing paths affected, data or API contracts touched, test coverage notes, and a blast radius rating (SMALL, MEDIUM, LARGE).
- [ ] Impact tab on the flag detail page: summary at the top, then a grouped list by file with the relevant snippet highlighted and a one-line explanation per reference.
- [ ] Dependency hints: if two flags appear in the same function, show a "Related flags" warning.
- [ ] Link results into the risk check from Phase 6 as an optional extra input (large blast radius raises the risk level one step).
- [ ] Snippets are shown in a code block with syntax highlighting and the mono font.

### Acceptance criteria

- For a flag referenced in 5 files, the analysis cites all 5 with correct line numbers.
- Never cites a file that is not in the reference list.

### Demo on its own

Open a flag, open Impact, show the blast radius and per-file explanations.

---

## 16. Phase 11: AI 7, Experiment analysis

Goal: for A/B flags, report results in plain language with honest uncertainty.

Depends on: Phase 4 and MetricEvent data (real or simulated).

### Tasks

- [ ] Experiment setup: choose a flag, a primary metric, optional guardrail metrics, minimum sample size, start and end.
- [ ] Statistics in code, not in the model: conversion difference, confidence interval, p-value (two-proportion z-test), required sample size estimate, and sample ratio mismatch check.
- [ ] Model receives the computed numbers and writes the summary: what happened, how confident we are, what to do next (ship, keep running, stop). It must not recompute or contradict the numbers.
- [ ] Results page: variant comparison cards, a chart with confidence intervals, a verdict badge (Winner, No clear difference, Not enough data, Harmful), and the generated summary in an AI panel.
- [ ] If sample size is below the minimum, the verdict is always "Not enough data" regardless of model text.
- [ ] Simulated experiment dataset included for demos.

### Acceptance criteria

- On a seeded dataset with a known 3 percent lift and large sample, the verdict is Winner and the summary states the lift and interval correctly.
- On a small sample, the summary says confidence is low.

### Demo on its own

Open the seeded experiment, show the chart, verdict, and plain-language summary.

---

## 17. Phase 12: AI 8, Chat assistant over flags

Goal: ask questions about flags and changes in plain English.

Depends on: Phase 4 tool definitions. Uses read-only tools, so it works on seeded data.

### Tasks

- [ ] Assistant page and a slide-over panel reachable from any screen.
- [ ] Tool-using agent: the model calls `list_flags`, `get_flag`, `get_audit_events`, `get_metrics`, and `get_references` to answer. All tools are read-only and scoped to the user's workspace.
- [ ] Example questions shown as suggestion chips: "Which flags are risky right now?", "What changed before last night's errors?", "Which flags have no owner?", "Show flags that have been on for over 60 days."
- [ ] Answers include links to the flags they mention (flag keys rendered as links).
- [ ] Streaming responses, a "Show tool calls" expander for transparency, conversation history saved in `ChatThread` and `ChatMessage`.
- [ ] Guardrails: cannot modify data, cannot reveal SDK keys, says "I do not have that data" instead of guessing.
- [ ] Optional: "Propose change" button that hands a suggested change to the Phase 5 preview drawer, still requiring user confirmation.

### Acceptance criteria

- Answers to the 4 example questions are correct against the seeded data.
- No tool call ever crosses workspace boundaries.

### Demo on its own

Ask "What changed before last night's outage?", show the tool calls, and follow the link to the flag history.

---

## 18. Phase 13: Polish, demo, and resume

Goal: make the project look and feel finished.

### Tasks

- [ ] Landing page: headline, one-sentence explanation, product screenshots, a short feature grid with Lucide icons, GitHub sign-in button. No emojis.
- [ ] Onboarding checklist on the dashboard: create a flag, copy an SDK key, install the SDK, see the first evaluation.
- [ ] Empty states, loading skeletons, and error states audited on every page.
- [ ] Keyboard shortcuts: Cmd+K palette, `g f` for flags, `n` for new flag.
- [ ] Performance: flags page under 1 second, no layout shift, images optimized.
- [ ] Accessibility pass with an automated checker plus keyboard-only navigation.
- [ ] Emoji audit: search the whole repo for emoji characters and remove any found.
- [ ] README: overview, architecture diagram, screenshots, setup steps, SDK usage example, list of AI features, benchmark results, and known limitations.
- [ ] Record a 2 to 3 minute demo video following the script below.
- [ ] Seed a demo workspace that resets with one command.

### Demo script (3 minutes)

1. Sign in with GitHub and land in the workspace (15 seconds).
2. Type a sentence to create a flag with AI, review, create (30 seconds).
3. Run the example app, toggle the flag, watch it update live (30 seconds).
4. Edit a Production flag, show the risk check and safer plan (30 seconds).
5. Start a ramp, inject errors, show the automatic rollback and explanation (45 seconds).
6. Show the stale flag cleanup pull request on GitHub (20 seconds).
7. Ask the assistant a question about recent changes (10 seconds).

### Resume bullets (fill in real numbers)

- Built a hosted feature flag platform (Next.js, TypeScript, PostgreSQL) with GitHub OAuth, role-based access, and a local-evaluation SDK delivering updates in under N seconds via SSE.
- Implemented sticky percentage rollouts with consistent hashing; evaluation latency of N microseconds per check and bucket distribution within 1 percent of target at 100k users.
- Added eight LLM-powered features: natural-language flag creation, rollout risk analysis, automated stale-flag cleanup pull requests, audit summaries, auto-rollback, impact analysis, experiment analysis, and a tool-using chat assistant.
- Enforced AI reliability with schema-validated structured outputs, deterministic pre-checks, confidence thresholds, and mandatory human confirmation before any change.
- Automated stale-flag cleanup through a GitHub App that scans repositories and opens reviewed pull requests.

Only claim numbers you measured.

---

## 19. Parallel work split (for a team of 3)

| Person | Order of work |
|---|---|
| A (platform) | Phase 0, 1, 2, then 13 |
| B (SDK and data) | Phase 3, then 9, 11 |
| C (AI) | Phase 4, then 5, 6, 8, then 7, 10, 12 |

Sync points: end of Phase 0 (contracts frozen), and a mid-point merge when Phases 2, 3, and 4 are done.

---

## 20. Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM returns invalid JSON | Zod validation with one retry and a clear error state |
| LLM latency hurts UX | Fast model for summaries, caching, usable UI while loading |
| API cost or rate limits | Per-user rate limit, daily budget cap, mock mode for development |
| GitHub App setup takes too long | Fixture scan and diff preview let the UI ship first |
| Auto-rollback misfires | Statistics decide, opt-in per flag, manual override, audit event for every action |
| AI changes data unexpectedly | Every AI output is a suggestion; applying requires an explicit click |
| Demo environment fails | Seeded data, simulator, recorded video as backup |

---

## 21. Definition of done

- [ ] Deployed URL works with GitHub sign-in.
- [ ] Flag lifecycle works end to end with audit trail.
- [ ] Example app reacts to flag changes live through the SDK.
- [ ] All eight AI features are reachable from the UI and validated by schema.
- [ ] No emoji exists anywhere in the repository, UI, or AI output.
- [ ] Light and dark mode both look correct.
- [ ] README has screenshots, setup steps, and benchmark numbers.
- [ ] Demo video recorded.
