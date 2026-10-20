# @flagforge/sdk

Dependency-free TypeScript SDK for Node 22+ and modern browsers (fetch, streams,
Web Crypto). The evaluator is bundled into the ESM and CommonJS exports; shared
Zod contracts are not shipped as a runtime dependency.

## Server usage

```ts
import { init } from "@flagforge/sdk";

const flags = await init({
  baseUrl: "http://localhost:3000",
  sdkKey: process.env.FLAGFORGE_SDK_KEY!,
  keyType: "SERVER",
});
const user = { id: "customer_1042", attributes: { country: "IN", plan: "pro" } };
flags.isEnabled("checkout_refresh", user, false);
flags.getValue("checkout_copy", user, "Continue");
const unsubscribe = flags.onChange(() => {
  /* Re-render or invalidate your view. */
});
flags.track("checkout_conversion", 1, "checkout_refresh", user);
unsubscribe();
await flags.close();
```

Keep SERVER keys out of browser code, URLs, and logs. Keys travel only in the
Authorization header. CLIENT keys require `keyType: "CLIENT"` and a fixed `user`
in `init`; only resolved values are downloaded. Calls for another user's id or
attributes return the supplied fallback. Create a new client when that context
changes. Client-side attributes are not trustworthy authorization evidence:
enforce permissions on your own backend, never with a browser flag alone.

## Behavior

- `init` attempts config fetch, then resolves even if delivery is unavailable.
- Evaluations are synchronous and local to memory. Before a valid snapshot, or
  when a flag is absent, the supplied fallback is returned without exposure.
- First matching AND rule wins; otherwise `defaultServe` applies. Missing
  attributes do not match, even for negated operators. Disabled flags serve off.
- Stable UTF-8 Murmur3 bucketing keeps assignments sticky as percentages grow.
- Authenticated fetch SSE reconnects; 30-second polls repair missed updates.
  ETags avoid redownloading unchanged config. Network failures retain the last
  valid config; caches are per process and are lost on restart.
- Exposures are queued using SHA-256 of user IDs, never raw IDs. Metrics and
  exposures flush every 10 seconds, at most 500 per request and 1,000 queued.
  Delivery is best effort: a failed response retried after a committed write can
  duplicate events. This is not billing-grade exactly-once telemetry.
- `close` aborts requests, stops timers/streams, and attempts a bounded flush.
  After close, evaluations use fallback. Call it when your app shuts down.
- `refresh` and `flush` are available for explicit updates and tests.
- Optional intervals and `fetch` injection support deterministic tests. The
  default request timeout is five seconds and is capped at 30 seconds.

## Build and packaging

From the repository root:

```bash
npm ci
npm run sdk:build
npm run test:phase3
npm pack --workspace @flagforge/sdk --dry-run
```

The package is publish-ready but has **not** been published to npm. Registry
publication needs an authorized account with access to the `@flagforge` scope.
Use the local workspace or `npm pack --workspace @flagforge/sdk` meanwhile.
