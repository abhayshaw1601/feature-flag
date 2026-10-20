# Checkout example design

## Brief and acceptance criteria

A developer can change the sample customer ID, then see which checkout their
server-side FlagForge evaluation selects. A one-second browser refresh reads the
SDK cache, allowing SSE changes to appear within three seconds on a healthy local
connection. A control-plane outage preserves the SDK's cached evaluations.
Missing environment configuration, startup with no configuration, and a failed
browser request each have an explicit state and an appropriate next action.

## Data and jobs

- Product: FlagForge's customer-app example, scoped to a checkout preview.
- Viewer: a developer testing a local flag, on desktop or a 390px phone.
- Job: change a bounded customer ID and observe the checkout variant.
- Default customer: `customer_1042`, country `IN`, plan `pro`.
- Evaluation: enabled/off, safe default, or SDK cache; never raw configuration.
- The SDK key and targeting rules stay on the server.
- Refresh: one second from the browser, without per-request SDK initialization.
- Cart: one canvas tote at INR 1,200 and one notebook at INR 350.
- Total: computed from item quantities and prices; INR 1,550.
- Checkout preview: classic review flow or refreshed express review, with a local
  order-review interaction; no payment collection or order submission.

## Question and composition

**Which checkout does this user see?** The checkout variant is the main answer.
Customer context and cache status sit beside it. No charts or additional navigation
are needed for this single-screen example.

```text
FlagForge / Customer app                         Server-side example
Checkout preview                              Refresh evaluation
Customer ID + Apply
Evaluation and sample context | Selected checkout + cart + review
```

On a phone, the customer control and status precede the checkout. The grid is
left-aligned and uses equal outer margins. The state-changing checkout is the
signature element; the preview's state label and its behavior share one boolean.

## Tokens and brief review

Use local Fontsource Inter for UI and JetBrains Mono for identifiers and code.
Core palette: paper `#ffffff`, ground `#f5f7f8`, ink `#172126`, muted `#55616a`,
border `#dce2e5`, enabled `#176343`. Status colors carry meaning; chrome stays
neutral. Type scale: 13 / 14 / 16 / 24 / 30px. Spacing uses a 4px base.

The initial dashboard framing was reduced to a single working screen: a sidebar
and metric cards would hide the actual customer checkout. Use plain semantic CSS,
quiet borders, no gradients or shadows, Lucide icons, text beside status dots,
visible focus, 44px mobile controls, and reduced-motion support.

## Style and final visual check

Draw: **Achromatic ledger**, seed **1903589270**, with the brief's palette and
type kept. Its face is the low-chroma blue-grey ground and its signature is the
enabled/off result selecting a real checkout component. The initial open-plane
sidebar was redrawn once because this example has only one destination. The
replacement icon rail also assumed multiple destinations; the brief's small-app
scope takes precedence, using the app reference's no-sidebar shell instead.

Both local fonts were verified loaded. JetBrains Mono is used only for identifiers
and their input; that is the reason for the source linter's generic mono warning.
No photographs, external imagery, or custom illustrations are used. The tote,
notebook, prices, customer ID, and fixed IN/pro attributes are sample content in
`lib/cart.ts` and `lib/evaluation.ts`.

Final inspection: **0 failures, 0 warnings** at 1440, 768, and 390px. All six final
fold/page screenshots were opened and reviewed. The first round found a missing
rupee glyph with the Latin-only font subset and too much 12px text. Prices now use
the explicit `INR` code, and supporting text is 13px. The phone refresh control is
a labelled 44px icon button, recovering space above the result.

### App-screen critique, final round

1. **Question:** the 30px enabled/off result answers the screen's question first;
   checkout selection agrees with it and the money total stays smaller at 24px.
2. **Edges:** margins match, both desktop panels share the same top edge, and
   content fills their natural heights. The small bottom-edge difference follows
   real content rather than stretching an empty panel. The tablet stacks panels.
3. **Color:** the enabled text/dot and delivery check carry the semantic green;
   navigation, controls, and cart stay neutral. No chart or decorative hue is used.
4. **Numbers:** INR 1,200.00 + INR 350.00 = INR 1,550.00, computed from cart rows.
   Quantity, review total, and displayed total use those same data. The browser
   check time is explicitly not a control-plane health measurement.
5. **Missing states:** the unloaded time says “Not yet”; no flag uses the explicit
   off default, and a missing environment has an actionable sanitized message.
6. **Marks:** the status dot has adjacent status text. There are no unexplained
   legends or data marks, and currency glyph fallback has been removed.
7. **Phone:** the question and customer control fit at 390px without horizontal
   scrolling; the checkout follows the context panel. Context-first reading order
   is deliberately kept for this developer example. All actions remain usable.

## Verification recorded 2026-10-20

- Nine offline smoke tests passed, including the real built SDK against a local
  HTTP/SSE fixture, cache preservation during outage, and a cold-start outage.
- Example TypeScript check passed against the real SDK declarations.
- Prettier checks passed for the application, configuration, README, and tests.
- Production `next build --no-lint` passed, including Next's type validation.
- The default build and explicit ESLint command timed out. A standalone
  `require('eslint-plugin-react')` also timed out before any app linting; this is
  recorded as a local tooling blocker, not a passing lint check. No check was
  disabled in the project configuration or package build script.
- Production HTTP smoke passed for the page and the API's missing-environment,
  invalid-user, response-field, and no-store behavior.
- Chromium verified customer switching, order review, browser error/retry,
  cached upstream outage, local fonts, reduced motion, and 390px fit. The final
  real SDK SSE-to-visible-checkout change took **674ms** against a local fixture.
- The SDK's root workspace link is still coordinator-owned. Checks used an
  ignored example-local symlink to the real `packages/sdk` build. No SDK mock was
  substituted for typechecking, compilation, or browser integration.
- Docker and a database-backed control-plane outage were not run. The README
  provides exact manual outage and container steps after workspace integration.

Inspector output and the temporary browser harness live under ignored
`.taste-skill/`; they are verification artifacts, not runtime dependencies.
