# Phase 3: evaluator, SDK, and delivery

Implemented independently of Phase 2. No dashboard files or write hooks are
required: SSE observes committed `FlagEnvironment` and `Flag` changes through
the database, including archive/removal and restore.

## Files and commands

- `packages/evaluator/`: pure UTF-8 MurmurHash3 bucketing and all eight operators.
- `packages/sdk/`: dependency-free Node/browser ESM+CJS SDK and declarations.
- `lib/sdk-delivery.ts`: framework-independent HTTP/SSE handlers with a store boundary.
- `lib/sdk-store.ts`: real Prisma-backed key authentication, config reads, and ingest.
- `app/api/sdk/{config,stream,events}/route.ts`: Next.js Node runtime routes.
- `examples/next-app/`: independent customer checkout, SDK secret kept server-side.
- `tests/{evaluator,sdk,sdk-delivery,example-smoke}.test.ts`: offline checks.

```bash
npm ci
npm run test:phase3
npm run sdk:benchmark
npm run example:dev
```

Configure the example using `examples/next-app/.env.example`. Open
http://localhost:3001 after starting it; the FlagForge control plane runs on
http://localhost:3000. Full setup and outage walkthrough are in the example README.

## Wire contract

All SDK endpoints use `Authorization: Bearer <key>` and accept no cookies as
authentication. Invalid/revoked/missing keys return the same generic 401. Unknown
database failures return a sanitized 503 without exception/key logging.

- **GET config:** `{ data: { environmentKey, version, flags } }`, ETag, conditional
  304, private cache policy, and `Vary: Authorization, X-FlagForge-Context, Origin`.
- **CLIENT context:** `X-FlagForge-Context: encodeURIComponent(JSON.stringify(user))`,
  bounded to 8 KiB. Response includes only key, type, resolved value, and version;
  never rules, attributes, or on/off alternatives. ETags are scoped to context.
- **GET stream:** authenticated fetch SSE `event: config.changed` and JSON
  `{ version, changedFlagKeys }`. Initial notification closes startup races.
  One-second database polling works across processes, avoiding an in-memory-only
  event bus. Keys are rechecked every tick. Streams rotate at 55 seconds and
  terminate on disconnect/revoke; SDK reconnects and also polls every 30 seconds.
- **POST events:** `{ events: [...] }`, maximum 500 events / 256 KiB. Environment
  comes exclusively from the key, flag keys must exist there, exposure hashes must
  be SHA-256 hex, variation must be on/off/resolved, timestamps within the preceding
  seven days (five-minute forward clock tolerance). Inserts are transactional.
- Browser CORS allows SDK headers and exposes ETag, without credentialed cookies.

`version` is a deterministic 48-bit content revision, not a monotonically
increasing counter. Compare for inequality. It detects low-version row changes
even if another row has a much higher version. ETag uses full SHA-256. The rule
set's `defaultServe.rolloutPercent` is authoritative; writers must keep the legacy
`FlagEnvironment.rolloutPercent` display column synchronized.

## Verification evidence (2026-10-20)

- `npm run test:phase3`: **61 passed, 0 failed, 0 skipped**. Default one-second
  stream cadence delivered to the real SDK cache in 954.2 ms with an in-memory
  store; this excludes dashboard, PostgreSQL, and hosted-network time.
- `npm run sdk:build`: evaluator and SDK ESM/CJS/declaration builds passed.
- Targeted ESLint on Phase 3 source and tests: passed before the final cadence
  regression; the final repeat timed out at 120 seconds. Source formatting passed.
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: passed on
  the integrated working tree initially. A later run failed on a concurrent
  phase's missing `@/lib/auto-rollout/simulator` import; that file is not owned here.
- Distribution across 100,000 users: 9.946% at a 10% target, 50.143% at a 50%
  target; zero members of the original 10% lost when raised to 50%.
- Measured local benchmark, Node 22.23.3 Linux x64: median batch averages
  2.145 microseconds/default rollout, 3.933 microseconds/one AND rule,
  0.544 microseconds/disabled. Five 100k-evaluation samples after 100k warmup,
  including validation, matching, hashing and allocation. Not per-call percentiles.
- Example browser checks by the example implementation task: 1440/768/390px,
  zero inspector failures/warnings; fixture SSE-to-visible-change 674 ms.

## Open verification and operational limits

- Real database/dashboard-to-example end-to-end latency and hosted SSE have not
  been verified. Offline tests cover the actual handlers/SDK with an injected
  store, plus loopback HTTP/SSE example tests. These are not live PostgreSQL tests.
- Full root `npm test` reached typecheck but exceeded its 120-second bound while
  concurrent agents were editing. Full root and normal example builds exceeded
  240/180-second bounds. No complete-build pass is claimed for this combined tree.
  The example task separately passed a `--no-lint` build; that is not a full gate.
- Docker and npm registry publication are unrun. No credentials or scope access
  are available for publishing `@flagforge/sdk`; packaging is ready for local use.
- Per-connection one-second polling is a simple hackathon implementation, not a
  high-scale fan-out service. Use database notifications/shared delivery caching
  at scale. Telemetry retries are best effort and can duplicate committed events.
- Offline caching is deliberate availability behavior, not immediate revocation
  of already downloaded information. Do not use flags as an authorization system.
