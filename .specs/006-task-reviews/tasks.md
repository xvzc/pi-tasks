# Tasks — 006 Task Reviews

## T1. Model + persistence (`reviewOf`)

- [x] Add reviewer-owned `reviewOf: number[]` to `Task` (default `[]`);
  update `TASK_KEYS`, `parseTask` (missing → `[]`, ID-list validation),
  clones.
- [x] Old stores/history without `reviewOf` load as `[]`; writes emit it.

Satisfies: R1, S1, S2, A8

## T2. Create/update plumbing + `reviewOfRefs`

- [x] Extend `TaskCreateInput`/`TaskCreateBatchInput` (`reviewOf`,
  `reviewOfRefs`) and `TaskPatch` (`reviewOf` replacement).
- [x] Extend tool schemas in `src/index.ts` (TypeBox, ref pattern, never
  persisted refs); pass through to store.
- [x] Validate shapes, unknown/self refs; resolve `reviewOfRefs` after
  explicit `reviewOf`; order writers before reviewers; batch-cycle rejection.

Satisfies: R2, S3, S4, A2

Depends on: T1

## T3. Effective prerequisites + uniqueness + general eligibility helper

- [x] Preserve pure `effectivePrereqs` (reviewer union; deleted inert;
  writers exclude reviewers) and add `checkReviewUniqueness` (E4).
- [x] Add general pure `transitionEligibility(current, proposed,
  proposedTasks, appendLog?)` returning allowed/denied discriminated result
  in existing error order (deleted-terminal, failed-appendLog, max-attempt,
  overflow, prerequisite completion); lifecycle side effects remain in the
  store.
- [x] Route reviewer existence/self/cycle, reviewer `in_progress` rule, and
  reviewer pending suffix through `eff`; writer gating uses only its own
  `blockedBy`; deletion guard checks `blockedBy` plus incoming `reviewOf`
  edges.

Satisfies: R3, R4, R5, S5, S6, S7, S14, A1, A3, A4, A6

Depends on: T2

## T4. `clearCompleted` fixed-point preservation

- [x] Retain completed writers directly/transitively referenced by surviving
  non-deleted reviewers; strip only removable IDs from both edges; no
  dangling `reviewOf`; keep timing/atomic/no-op behavior.

Satisfies: R6, S9, S13, A5, A6

Depends on: T3

## T5. Glyphs, frames, and viewer/tool display

- [x] Extend normalized config (`pending.retriedCharacter`,
  `completed.awaitingReviewCharacter`, `inProgress.frames`) with R7 defaults;
  normalize character-only legacy input into variant/frame fields, with valid
  explicit frames taking precedence and retaining same-width legacy blink.
- [x] Render `◌/■/✕/⌫/○/●` + `◌ ○ ⨀ ◉ ● ◉ ⨀ ○ ◌` at 250 ms; static surfaces use
  first frame; header counts by `status`; reviewer `Review of` row; reviewer
  `eff` / writer `blockedBy` suffixes; S8 accepted-`●` presentation
  (completed reviewer approves directly reviewed writer even under an active
  upper reviewer).

Satisfies: R7, R8, S8, S10, S11, S12, A4, A7

Depends on: T3

## T6. Tests + validation

- [x] Add/extend store, config, and widget tests for A1–A8 (uniqueness,
  `reviewOfRefs` batch, directional gating + S8 presentation, deletion guard
  review arm, fixed-point clear incl. transitive/deleted cases,
  `transitionEligibility` order/purity, glyph/frames/config precedence,
  legacy load).
- [x] Run validation commands below; record results in `verification.md`.

Satisfies: A1, A2, A3, A4, A5, A6, A7, A8, A9

Depends on: T4, T5

## T7. Independent-review corrections

- [x] Keep exact pure-helper order: deleted-terminal, failed-entry appendLog,
  attempt cap, overflow, effective-prerequisite self/missing structure, then
  prerequisite completion; keep cycle and uniqueness validation later.
- [x] Normalize glyph compatibility into ordinary enumerable fields: valid
  explicit frames win, frames require equal visible width, invalid frames fall
  back, and character-only pending/completed/in-progress input expands to its
  compatible variant/frame values even at default-valued characters.
- [x] Verify normalized in-progress config survives object spread and JSON
  round-trips without private provenance or value comparisons.
- [x] Render filtered `task_list` rows against the full store snapshot so
  reverse-review state remains visible.
- [x] Add focused regressions and rerun focused, typecheck, and full-suite
  validation.

Satisfies: S7, S10, S12, S13, S14, A1, A4, A7, A9

Depends on: T6

## Validation commands

```bash
npm run typecheck
npm test
```

Known unrelated baseline (out of scope, do not fix here): typecheck passes;
`npm test` 328/329 passing with existing `test/tools.test.ts` prompt-string
failure.

## Traceability

- T1 → R1 → S1, S2 → A8
- T2 → R2 → S3, S4 → A2
- T3 → R3, R4, R5 → S5, S6, S7, S14 → A1, A3, A4, A6
- T4 → R6 → S9, S13 → A5, A6
- T5 → R7, R8 → S8, S10, S11, S12 → A4, A7
- T6 → N1, N2 → A1–A9
- T7 → N2, S12, S14 → A1, A7, A9
