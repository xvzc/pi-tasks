# Verification — Task Tool Rendering

> Status: IMPLEMENTED — T10 pending accent/toolTitle refinement, focused rendering,
> actual Pi host/export composition, focused integration/registration, and
> typecheck pass. The full suite retains one accepted unrelated workflow-policy
> assertion failure.

## Acceptance Criteria

| Criterion                                                             | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Result                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A1 (create rendering and unchanged model JSON)                        | `test/tool-rendering.test.ts` create exact-string tests; `test/tools.test.ts` integration JSON + details assertions                                                                                                                                                                                                                                                                                                                                                   | PASS                                        |
| A2 (snapshot semantic update diff, order, aliases, no-op)             | `test/tool-rendering.test.ts` semantic diff/order/no-op tests; `test/tools.test.ts` snapshot-backed integration assertion                                                                                                                                                                                                                                                                                                                                             | PASS                                        |
| A3 (get operational view)                                             | `test/tool-rendering.test.ts` exact `#id subject` get view, latest-three ordering, placeholders, attempts, omission assertions                                                                                                                                                                                                                                                                                                                                        | PASS                                        |
| A4 (filtered/list/empty rendering)                                    | `test/tool-rendering.test.ts` ordered filtered and empty-list exact assertions                                                                                                                                                                                                                                                                                                                                                                                        | PASS                                        |
| A5 (delete success title only)                                        | `test/tool-rendering.test.ts` exact `#id subject` success/error assertions; `test/tools.test.ts` integration assertion                                                                                                                                                                                                                                                                                                                                                | PASS                                        |
| A6 (five exact error lines, sanitization/masking)                     | `test/tool-rendering.test.ts` all operation summaries, expected detail, host `context.isError`, exact `Unexpected internal error.` masking, malformed/absent details, and safe missing context/args fallback assertions                                                                                                                                                                                                                                               | PASS                                        |
| A7 (width/control safety and no progress callbacks)                   | `test/tool-rendering.test.ts` narrow-host plain/themed width, control, and suffix-preservation assertions; `test/tools.test.ts` callback remains unused across all five tools                                                                                                                                                                                                                                                                                         | PASS                                        |
| A8 (schemas and model JSON/error text unchanged)                      | Existing schema/model assertions in `test/tools.test.ts`; focused fallback/passthrough assertion; presentation data stored only under `details`                                                                                                                                                                                                                                                                                                                       | PASS (focused); full suite limitation below |
| A9 (interactive count-free animated labels for all five tools)        | Fake-timer and registered-renderer tests cover normal pre-execution creation, execution-started continuation, exact labels, frame advance, complete/partial args, and static missing-ID fallback; T10 pending-theming tests cover `accent` frame + `toolTitle` label call sequences on animated and static labels for all five tools, registered host-theme threading, frame advance, theme refresh on reuse, ANSI-aware width safety, and plain/theme-throw fallback | PASS                                        |
| A10 (settled success/error/empty/detail themes and fallback)          | Theme-call assertions cover `success`, `toolTitle`, every `toolOutput` detail, `error`, and `dim`; plain and theme-throw fallback plus themed width are asserted                                                                                                                                                                                                                                                                                                      | PASS                                        |
| A11 (interactive visibility, export omission, cleanup, default shell) | Actual Pi 0.85.1 `ToolExecutionComponent` test covers all five interactive calls through settled themed result; actual `createToolHtmlRenderer` tests cover five completed exports and a result-less call with no loading HTML, spinner frame, or timer. Unit tests cover zero-line no-prior/settled `Container`, stable-ID reuse/recovery, stale replacement, invalidation failure, result-side cleanup, zero state/timers, and absent `renderShell`                 | PASS                                        |

## Commands

```bash
npx vitest run test/tool-rendering.test.ts
# PASS: 1 file, 24 tests

npx vitest run test/tools.test.ts -t "creates, gets, lists, updates, and deletes through the tools"
# PASS: 1 test; 25 skipped

npx vitest run test/tools.test.ts -t "registers exactly the five task tools"
# PASS: 1 test; 25 skipped

npm run typecheck
# PASS: tsc --noEmit

npm test
# PARTIAL: 15 files passed, 1 failed; 310 tests passed, 1 failed
```

## Runtime/documentation inspection

- Confirmed installed `@earendil-works/pi-coding-agent` version `0.85.1`.
- Its `docs/extensions.md` documents an empty `Container` as the intentional no-visible-content component.
- Its `dist/modes/interactive/components/tool-execution.js` invokes `renderCall` before execution starts and adds it before `renderResult`; the focused host-composition test instantiates that runtime component directly and confirms animation remains visible.
- Its `dist/core/export-html/tool-renderer.js` first invokes `renderCall` with `executionStarted: true` and `isPartial: true`, then preserves that call HTML alongside the result. Focused tests instantiate `createToolHtmlRenderer` directly and confirm the no-prior-spinner path emits empty call HTML, retains settled result HTML, and creates no timers.

## Full-suite limitation

`npm test` fails only at the pre-existing unrelated test
`test/tools.test.ts > tool registration > appends workflow policy once when task_create is active`.
The dirty workspace's test expects the sentence beginning `Never treat new
findings...`, while the pre-existing `TASK_MANAGEMENT_PROMPT` in `src/index.ts`
does not contain it. The user explicitly approved recording this unrelated
failure without expanding scope. Task rendering tests pass, and this feature
does not modify workflow-policy text.

## Unverified

- A fully green `npm test` remains blocked by the unrelated workflow-policy
  expectation described above.
- No lint was run because the package has no lint script.
- No refinement criteria remain unverified.
