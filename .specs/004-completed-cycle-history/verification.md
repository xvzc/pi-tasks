# Verification

## Automated Checks

- `npm run typecheck` — passed.
- `npx vitest run test/store.test.ts test/lifecycle.test.ts test/batch.test.ts test/bulk-clear.test.ts test/session-start.test.ts` — passed, 116 tests.
- Focused tool archival/widget tests — passed, 3 tests.
- `git diff --check` — passed.
- `npm test` — 326 tests passed; 1 pre-existing unrelated assertion failed in `test/tools.test.ts` (`appends workflow policy once when task_create is active`) because the current prompt text does not contain the sentence expected by that test.

## Acceptance Evidence

- Turn-start tests verify completed/deleted terminal task snapshots and logs move into `history`, active tasks become empty, and `nextId` remains monotonic.
- Create fallback tests verify archival and new task creation occur in one write without ID reuse.
- Multiple-cycle coverage verifies history appends rather than overwrites.
- Store validation covers valid and invalid version-2 history and version-1 upgrade behavior.
- Manual `clearAll` coverage verifies previously archived cycles remain intact.
