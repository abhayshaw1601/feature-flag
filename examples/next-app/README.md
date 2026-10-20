# FlagForge customer-app example

A small Next.js 15 App Router app on **http://localhost:3001**. It uses the local
`@flagforge/sdk` package on the server to switch between classic and express
checkout. It is private and **not published**. The cart is sample data; its review
button is a local interaction, not a payment or order submission.

## Prerequisites and exact setup

- Node **22.23.3** (`.nvmrc`) and npm 10, matching the repository.
- Root dependencies installed from the repository's `package-lock.json`.
- Built `packages/sdk/dist` with the SDK's ESM/CJS exports and declarations.
- The root workspace integration must include `packages/sdk` and
  `examples/next-app`, with `@flagforge/sdk` linked by the root install. This
  example resolves dependencies through the root workspace; it has no separate
  install or lockfile. The workspaces are registered in the root package and lockfile.
- A running FlagForge control plane on port 3000 for live flag changes. Follow
  the root README for its database and authentication setup.

From the **repository root**, after workspace integration:

```bash
nvm use
npm ci
npm run build --workspace @flagforge/sdk
cp examples/next-app/.env.example examples/next-app/.env.local
```

Edit `examples/next-app/.env.local`:

```dotenv
FLAGFORGE_SDK_KEY=<your environment's SERVER SDK key>
FLAGFORGE_URL=http://localhost:3000
FLAGFORGE_FLAG_KEY=checkout_refresh
```

Obtain a **SERVER** SDK key for the environment you want to test. Create a Boolean
flag named `checkout_refresh` in that environment, with `onValue: true` and
`offValue: false`. Set its rollout to 100% for a predictable on/off demonstration,
or target `country equals IN` and `plan equals pro`. If that flag already exists,
use it. A different flag can be selected with `FLAGFORGE_FLAG_KEY`.

The key must be a server environment variable. Never put it in a `NEXT_PUBLIC_*`
variable, client code, browser request, URL, or committed file. `.env.local` is
ignored. Restart the example after changing any environment setting.

Start the control plane in one terminal and this example in another:

```bash
# Terminal 1, repository root; after the root app's database setup
npm run dev

# Terminal 2, repository root
npm --prefix examples/next-app run dev
```

Open **http://localhost:3001**. The default customer is `customer_1042`, with
attributes `{ country: "IN", plan: "pro" }`. Changing the ID and choosing **Apply**
checks another rollout assignment. The ID is bounded to 1–80 ASCII letters,
digits, `.`, `_`, `:`, `@`, and `-`, starting with a letter or digit.

Without a key, the page and API still work: they show **Environment setup needed**
and the safe off checkout. An invalid URL or flag name also produces a sanitized
configuration error. An unavailable server, invalid/revoked key, empty environment,
or absent flag shows **Waiting for a cached flag** after initialization. Those
cases cannot be distinguished through this SDK's public API, so the UI gives the
configuration checks without claiming a connection is healthy.

## API and caching

```bash
curl -i 'http://localhost:3001/api/evaluate?userId=customer_1042'
```

The response contains only:

```json
{
  "userId": "customer_1042",
  "enabled": true,
  "source": "cache",
  "status": "ready",
  "message": null,
  "cacheUpdatedAt": "2026-10-20T12:00:00.000Z"
}
```

The timestamp above is illustrative. `cacheUpdatedAt` records the first observed
cached evaluation or the last SDK change callback, **not** a successful upstream
health check. `source` is `default` before a flag is cached, and `cache` afterward.
Other statuses are `configuration-error`, `initializing`, `waiting`, and
`sdk-error`. Missing `userId` uses the sample customer; empty, duplicate, malformed,
or overlong IDs return 400. Unexpected handler failures return a sanitized 503.
All responses have `Cache-Control: private, no-store, max-age=0`.

`lib/flagforge.server.ts` is guarded by `server-only` and keeps one SDK client on
`globalThis` per Node process, including development hot reloads. It asynchronously
calls `init({ baseUrl, sdkKey, keyType: "SERVER" })`; HTTP requests never await SDK
network startup. The SDK owns its 30-second polling and authenticated SSE stream.
Each API request calls `isEnabled(flagKey, { id, attributes }, false)` against its
current in-memory configuration. `getValue` only checks whether the flag exists
using a reference sentinel; arbitrary values are never sent to the browser.
`onChange` records cache changes. The store's `close()` closes its client for
explicit teardown/tests; normal requests keep the client alive.

The browser requests this app's API every second, without overlapping requests,
and aborts obsolete requests when the user changes. Refresh errors keep the last
result for the current customer and offer **Retry now**. There is no unbounded
per-user result map and no dependency on the control plane's UI or Phase 2 files.

## Test live changes and outages

1. Run both apps and wait for **Reading the SDK cache**.
2. Enable the configured flag at 100% rollout. The page should read **Enabled**
   and show **Express checkout**. Disable it; expect **Off** and **Classic checkout**.
   With a healthy SSE connection and local server, this should appear within three
   seconds: SSE updates the SDK cache, then the browser reads it within one second.
   If SSE is unavailable, the SDK's 30-second poll is the repair path.
3. Enable the flag again and wait for **Enabled**. Stop **only FlagForge on port
   3000**. Leave the example on port 3001 running. Wait at least 35 seconds and use
   **Refresh evaluation**. The result should remain enabled from the SDK cache.
   Try another customer ID: it evaluates locally against the same cached rules.
4. Restart FlagForge, disable the flag, and confirm the page eventually switches
   back without restarting the example. Reconnect/poll timing can be longer than
   the healthy-connection three-second target.
5. For a cold-start outage, stop both apps, then start only the example with a key
   configured. The page/API should stay responsive, initially show **Starting the
   server SDK**, then **Waiting for a cached flag**, and use the off default.
   Start FlagForge and allow SSE reconnect or polling to recover.
6. Stop port 3001 while leaving the tab open. It should retain its last result and
   show a request error with **Retry now**. Restart it and retry.

Cache is in-memory and per process. Restarting the example loses it. An upstream
outage is not an error from this app's API when the SDK can serve cached data.

## Offline tests, typecheck, and production build

From the repository root:

```bash
# Single offline test command; needs installed root dependencies, not a database
npm --prefix examples/next-app test

# Requires the local SDK's built package to resolve
npm --prefix examples/next-app run typecheck
npm --prefix examples/next-app run lint
npm --prefix examples/next-app run build
npm --prefix examples/next-app run start
```

The smoke tests cover safe environment errors, non-blocking startup, one client
across requests, cached user decisions and changes, absent versus null values,
retry timing, teardown, bounded IDs, sanitized API errors, no-store headers, and
cart arithmetic. The SDK integration test uses its real local build and a loopback
HTTP/SSE fixture, so it is offline; build the SDK before running the tests.
It does not replace the real control-plane outage walkthrough above.

## Container deployment

The example Dockerfile uses the **repository root** as its build context, consumes
the root lockfile, builds the local SDK, tests and builds the example. After the
coordinator has integrated the workspaces:

```bash
docker build -f examples/next-app/Dockerfile -t flagforge-example .
docker run --rm -p 3001:3001 --env-file examples/next-app/.env.local flagforge-example
```

Set `FLAGFORGE_URL` to a control-plane URL reachable **from inside the container**;
`localhost:3000` there refers to that container. For Docker Compose, use the control
plane service name. Supply the SERVER key at runtime, not during image build.
Use a long-lived Node process for the persistent SDK cache and SSE connection.
Publishing to npm or deploying a hosted instance is not part of this example yet.
