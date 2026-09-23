# Verification — 006 Task Reviews

## Acceptance Criteria

| Criterion | Verification | Result |
|---|---|---|
| A1 | `test/reviews.test.ts` reviewer transition gating and exact lifecycle/structure/completion error order | PASS |
| A2 | `test/reviews.test.ts` `reviewOfRefs` allocation, linking, and writer-before-reviewer order; tool contract coverage in `test/tools.test.ts` | PASS |
| A3 | `test/reviews.test.ts` active-reviewer uniqueness and deleted-reviewer replacement | PASS |
| A4 | `test/reviews.test.ts` directional writer/reviewer gating and direct-review acceptance through a reviewer chain | PASS |
| A5 | `test/reviews.test.ts` fixed-point retention and removal of an unpinned completed review chain | PASS |
| A6 | `test/reviews.test.ts` deleted-reviewer deletion/clear behavior | PASS |
| A7 | Config, widget, viewer, and tool-rendering tests cover defaults, normalized legacy overrides, equal-width frames, explicit-frame precedence, spread/JSON round-trips, static glyphs, review presentation, and six-frame animation | PASS |
| A8 | `test/reviews.test.ts` legacy load defaults `reviewOf` to `[]` and next write emits it | PASS |
| A9 | Typecheck passes; full suite has only the documented unrelated prompt-string failure | PASS with known baseline failure |

## Review Corrections

| Finding | Verification | Result |
|---|---|---|
| Pure helper order is deleted-terminal → failed appendLog → cap → overflow → effective-prerequisite self/missing → completion | `test/reviews.test.ts` combines every higher lifecycle error with invalid/self `reviewOf`, then checks structural and completion errors | PASS |
| Config normalization uses only ordinary enumerable values; valid frames win; invalid frames fall back; pending/completed/in-progress character-only compatibility is materialized | `test/config.test.ts` and `test/unlimited.test.ts`, including default-valued overrides and spread/JSON rendering round-trips | PASS |
| Filtered `task_list` uses the full store for reverse-review glyph context | End-to-end `test/tools.test.ts` filtered completed-row regression | PASS |

## Commands

```bash
npx vitest run test/reviews.test.ts test/config.test.ts test/unlimited.test.ts test/widget.test.ts test/tasks-ui.test.ts test/tool-rendering.test.ts
```

Result: 6 test files passed; 146/146 tests passed.

```bash
npx vitest run test/tools.test.ts -t "renders filtered completed rows with full reverse-review context"
```

Result: 1 test passed; 28 tests skipped.

```bash
npm run typecheck
```

Result: PASS (`tsc --noEmit`, exit 0).

```bash
npm test
```

Result: 16/17 test files passed; 343/344 tests passed. The sole failure is the documented pre-existing assertion in `test/tools.test.ts` (`appends workflow policy once when task_create is active`) expecting the removed sentence beginning “Never treat new findings...”. No new full-suite failures were introduced.

## Unverified

None beyond the documented unrelated baseline failure.
