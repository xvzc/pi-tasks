# Verification

## Automated Checks

- `npm run typecheck` — passed.
- Focused store, deleted-timing, tool, renderer, widget, config, `/tasks`, lifecycle, bulk-clear, and command tests — 265 passed; only the pre-existing unrelated task-management prompt assertion failed.
- `git diff --check` — passed.
- `npm test` — 328 tests passed; 1 pre-existing unrelated assertion failed in `test/tools.test.ts` (`appends workflow policy once when task_create is active`) because the current prompt text does not contain the scope-expansion sentence expected by that test.

## Acceptance Evidence

- Registration tests verify exactly four tools and no `task_delete` registration.
- Store tests verify persisted deleted tombstones, terminal transition enforcement, referencer protection, atomic dependent/dependency deletion, log retention, and persistence rollback.
- Timing tests verify in-progress to deleted freezes attempt duration and correctly updates union timing.
- Lifecycle/history tests verify completed/deleted-only cycles archive together and preserve monotonic IDs.
- Widget and `/tasks` tests verify deleted records remain visible with deleted labeling, dim glyphs, strikethrough styling, and header counts.
- Repository search finds no `task_delete`, `TaskDelete`, delete renderer, or deleting-call label in source or tests.
