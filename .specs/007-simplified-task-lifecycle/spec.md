# Specification — 007 Simplified Task Lifecycle

## Behavior

- S1: `TaskStatus` (R1) and `TASK_STATUSES`/`isTaskStatus` accept exactly
  `pending`, `in_progress`, `paused`, `completed`, `deleted`.
- S2: `ALLOWED_TRANSITIONS` in `src/types.ts` is the single immutable source
  of truth (R2):
  `pending: [in_progress, deleted]`,
  `in_progress: [paused, completed]`,
  `paused: [in_progress, deleted]`,
  `completed: [in_progress]`,
  `deleted: []`.
- S3: `transitionEligibility(current, proposed, proposedTasks, appendLog?)`
  denies, in order: (1) deleted-terminal, (2) adjacency violation
  (`Task #<id> cannot transition from <from> to <to>.`), (3) missing
  `appendLog` on real transitions
  (`Transition to <status> requires a non-empty appendLog.`), (4)
  max-attempt cap, (5) attempt-counter overflow, (6) structural
  effective-prerequisite self/missing validation, (7)
  effective-prerequisite completion for `in_progress` (R2–R4).
- S4: `attempt` increments on every non-`in_progress` → `in_progress`
  (R4). `startedAt` is set on entry to `in_progress` and cleared when
  leaving it; `tookMs` freezes on entry to `paused`/`completed`/`deleted`
  (from a running attempt) and clears on entry to `in_progress` (R8).
  Global union timing runs while any task is `in_progress`; `paused` is
  inactive like other non-running states (R8).
- S5: `effectivePrereqs`, review uniqueness, deletion referencer checks,
  cycle detection, atomic `createMany`/`updateMany` (single write, full
  rollback), history archival (`completed`/`deleted` only), `clearCompleted`
  (retains review-pinned writers; `paused` survives), and `clearAll` are
  unchanged except `paused` takes the structural role `failed` held (R5, R8).
- S6: Pending/paused rows show the `→ (ids)` prerequisite suffix;
  `paused` rows append the frozen duration; the header shows
  `· N paused` when nonzero (R9). `paused` glyph defaults to `⏸`,
  themed `warning`; subjects render dim like completed (R9).
- S7: Tool schemas expose `paused` (not `failed`) for `task_update` status
  and `task_list` status; `appendLog` description requires it for every
  real status transition; the `<task-management>` prompt teaches
  start/pause/resume/complete/rework with per-transition logs and the
  atomic reviewer-pause + writer-reopen flow (R9).
- S8: Loader maps legacy `failed` → `paused` and legacy `pending` with
  `attempt > 0` → `paused` for active tasks (R7). History cycles still
  accept only `completed`/`deleted`. Legacy `failed` glyph config maps to
  `paused` with a rename warning (R10).

## Inputs

- `TaskUpdateBatchInput.status`: `pending | in_progress | paused |
completed | deleted`.
- `transitionEligibility`: unchanged signature; `appendLog?` now gates
  every real transition, not just failure entry.

## Outputs

- Created/updated `Task` JSON carries `paused` where applicable; `attempt`,
  `startedAt`/`tookMs`, `updatedAt`, and log behavior follow S4.
- `task_get`/`task_list` payloads and `/tasks` viewer/widget render
  `paused` per S6.

## Errors

- E1: `Task #<id> is deleted and cannot transition to another status.`
- E2: `Task #<id> cannot transition from <from> to <to>.`
- E3: `Transition to <status> requires a non-empty appendLog.`
- E4–E6: existing max-attempt, overflow, prerequisite, dependency-cycle,
  review-uniqueness, and deletion-referenced errors unchanged.

## Edge Cases

- `paused → paused` patches need no log and preserve the frozen duration.
- `in_progress → deleted` is rejected; pause first, then delete.
- `pending → completed` and `completed → pending` are rejected; the legal
  paths are `pending → in_progress → completed` and `completed →
in_progress` (rework).
- Rework batch (reviewer `in_progress → paused` + writer `completed →
in_progress`) validates against the proposed final state regardless of
  array order; resuming the reviewer later requires the writer `completed`.
- Deleting a writer still requires its non-deleted reviewers to delete in
  the same batch; `paused` reviewers count as referencers.

## Invariants

- I1: No transition outside `ALLOWED_TRANSITIONS` persists.
- I2: Every persisted real transition has a corresponding log entry.
- I3: `pending` tasks always have `attempt` 0 after migration.
- I4: `deleted` remains terminal; tombstones stay visible.

## Compatibility

- C1: v1/v2 stores with `failed` or retried-`pending` load and rewrite as
  `paused` without version bump or data loss beyond the status rename.
- C2: Configs with `glyphs.failed` load, warn once, and apply a valid
  `failed.character` to `paused` when `paused` is unset.

## Acceptance Criteria

- A1: `npm test` passes 17 files / 345 tests; `npm run typecheck` passes.
- A2: No `failed` status, schema, glyph default, prompt, or widget path
  remains except legacy-load shims and English prose.
- A3: Direct `pending → completed`, `completed → pending`,
  `in_progress → deleted`, and log-less transitions are rejected with
  E2/E3; the atomic rework batch succeeds either array order.
