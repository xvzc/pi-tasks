# Verification

## Automated Checks

- `npm run typecheck` — passed.
- `npx vitest run test/widget.test.ts test/session-start.test.ts` — passed, 78 tests.
- Focused widget-order/tool tests — passed.
- `git diff --check` — passed.
- `npm test` — 320 tests passed; 1 pre-existing unrelated assertion failed in `test/tools.test.ts` (`appends workflow policy once when task_create is active`) because the current prompt text does not contain the scope-expansion sentence expected by that test.

## Acceptance Evidence

- A host-order simulation verifies that adding `agents` after `tasks` and then updating task data keeps the key order `["tasks", "agents"]`.
- Lifecycle tests verify repeated refreshes of the same session perform one Tasks widget registration.
- Component tests verify an in-place snapshot update renders new data and starts/stops in-progress redraw timers.
