# Specification — 006 Task Reviews

## Behavior

- S1: `Task` gains `reviewOf: number[]` on review tasks; default `[]`.
  Persisted tasks without `reviewOf` load as `[]`.
- S2: `reviewOf` belongs to the reviewer; entries are task IDs of writer
  tasks it reviews. Empty means “not a reviewer”. Writers never list their
  reviewers; a writer’s own effective prerequisites exclude reviewers.
- S3: `task_create` accepts per-item `reviewOf?: number[]` and
  `reviewOfRefs?: string[]` (request-local refs, never persisted); `task_update`
  accepts `reviewOf?: number[]` as full replacement. Validation mirrors
  `blockedBy`/`blockedByRefs` (ID shape, ref shape, unknown-ref, self-ref).
- S4: Batch creation resolves `reviewOfRefs` to allocated IDs, appends them
  after explicit `reviewOf`, topologically orders writers before their
  reviewers on the union of `blockedByRefs` and `reviewOfRefs`, and rejects
  batch-local cycles.
- S5: Uniqueness: for any writer ID `W`, at most one task with
  `status !== "deleted"` may include `W` in `reviewOf`. Deleted reviewers are
  ignored. Violation rejects the whole batch atomically.
- S6: Effective prerequisites `eff(T)` = de-duplicated order-preserving union
  of `T.blockedBy` then `T.reviewOf`; if `T.status === "deleted"`,
  `eff(T)` = `T.blockedBy` (its `reviewOf` is inert). `eff` governs reviewer
  execution and graph validation: existence/self/cycle validation,
  topological batch ordering, reviewer pending display suffix, and reviewer
  `in_progress` eligibility. Writer tasks normally have `reviewOf: []`, so
  `eff(writer)` = `blockedBy`.
- S7: Transition gating is directional. A reviewer may enter or remain
  `in_progress` only when every ID in `eff(reviewer)` exists and has
  `status === "completed"`. A writer may enter or remain `in_progress` when
  every ID in its own `blockedBy` is `completed`; reviewer state never gates
  writer transitions.
- S8: Presentation approval (not transition gating): a completed reviewer
  causes each directly reviewed writer to render accepted `●`, even if that
  reviewer itself has an active reviewer. A completed writer with an active
  (non-deleted, non-completed) reviewer covering it renders awaiting-review
  `○`; all other completed tasks render `●`.
- S9: `clearCompleted` preserves via fixed point: starting from completed
  candidates, retain any completed writer reachable directly or transitively
  through `reviewOf` edges of surviving non-deleted review tasks; strip only
  removable IDs from `blockedBy`/`reviewOf` of survivors; never leave a
  dangling `reviewOf`. Otherwise existing manual-clear behavior remains
  (`paused`/`deleted` survive, no write when nothing removable, atomic write,
  timing handling unchanged).
- S10: Presentation defaults (normalized config):
  fresh pending (`attempt === 0`) `◌`, retried pending `■`, paused `⏸`,
  deleted `⌫` (plus current dim strikethrough), completed awaiting its active
  reviewer `○`, other completed `●` (including accepted writers per S8),
  `in_progress` frames `["◌","○","⨀","◉","●","◉","⨀","○","◌"]` at 250 ms.
  Static surfaces (plain lines, viewer rows, tool rendering) use the first
  frame. Header counts remain by actual `status`.
- S11: Pending display suffix shows the task’s own prerequisites when
  non-empty: reviewers show `eff`, writers show `blockedBy`. Completed
  awaiting-review uses the `○` glyph; accepted writers use `●` per S8.
- S12: Normalized config extends to `pending.retriedCharacter`,
  `completed.awaitingReviewCharacter`, `inProgress.frames`; legacy per-status
  `character` overrides remain effective. A legacy custom `inProgress`
  `character` retains same-width blink (blank of equal visible width).
- S13: All mutations stay atomic on the proposed final state; failed
  validation or persistence leaves state unchanged.
- S15 (007 amendment): `failed` is removed; `paused` replaces it in S9/S10/S14.
  Every real status transition requires a non-empty `appendLog`; the
  lifecycle graph is pending → in_progress|deleted, in_progress →
  paused|completed, paused → in_progress|deleted, completed → in_progress,
  deleted → none. Rework is reviewer in_progress → paused plus writer
  completed → in_progress in one atomic batch. See 007-simplified-task-lifecycle.
- S14: Pure status-transition eligibility helper
  `transitionEligibility(current, proposed, proposedTasks, appendLog?)`
  returns a discriminated result (`{ allowed: true }` vs
  `{ allowed: false, error: string }`) and covers, in existing error order:
  (1) deleted terminal rule, (2) adjacency + every-transition `appendLog` requirement,
  (3) `in_progress` max-attempt cap, (4) attempt-counter overflow,
  (5) structural effective-prerequisite self/missing validation,
  (6) effective-prerequisite completion. Lifecycle side effects (attempt
  increment, `startedAt`/`tookMs`, `updatedAt`, log append) remain in the
  store, not in the helper.

## Inputs

- `TaskCreateBatchInput`: optional `reviewOf?: number[]`,
  `reviewOfRefs?: string[]` with ref pattern `^[a-z][a-z0-9_-]*$`.
- `TaskUpdateBatchInput`: optional `reviewOf?: number[]` (replacement).
- Tool schemas expose the same fields with identical descriptions/patterns.
- `transitionEligibility`: `current: Task`, `proposed: Task` (candidate with
  caller fields applied), `proposedTasks: Map<number, Task>` (full proposed
  final state), `appendLog?: string`.

## Outputs

- Created/updated `Task` JSON includes `reviewOf`; batch result ordering and
  `ref → id` mappings unchanged except reviewer-after-writer ordering.
- `task_get`/`task_list` payloads include `reviewOf`; viewer detail shows
  `Review of` row on reviewers.
- `transitionEligibility` returns `allowed` or the exact existing error
  message for the first denied check in S14 order.

## Errors

- E1: Unknown `reviewOf` ID → `Task #<id> does not exist.` (same ordering as
  `blockedBy` checks, on the reviewer’s `eff`).
- E2: Self-review → `Task #<id> cannot depend on itself.` (reviewer lists
  itself in `reviewOf`).
- E3: Cycle through reviewer `eff` → `Task #<id> is part of a dependency cycle.`
- E4: Duplicate writer coverage → e.g.
  `Task #<writer> is already reviewed by #<reviewer>.` (whole batch rejected).
- E5: `reviewOf` shape violations mirror `blockedBy` messages; unknown
  `reviewOfRef` mirrors `Unknown blockedByRef: <ref>.`; batch-local cycle
  mirrors existing batch-cycle error.
- E6: Reviewer `in_progress` with uncompleted `eff` →
  `Task #<id> cannot remain in_progress: dependencies not completed: …`
  listing reviewer `eff` IDs in union order. Writer `in_progress` lists only
  its own uncompleted `blockedBy`.
- E7: Deleting a writer referenced by `reviewOf` of a non-deleted reviewer,
  or deleting a task referenced by `blockedBy` of a non-deleted task →
  `Task #<id> cannot be deleted: referenced by …`. The review arm is an
  incoming-edge check; it does not come from the writer’s own `eff`.
- `transitionEligibility` preserves existing transition behavior and error
  ordering: it emits E-order equivalents for (1) deleted-terminal,
  (2) adjacency/appendLog, (3) max-attempt, (4) overflow, (5) prerequisite
  completion at the same call sites; the store applies side effects only on
  `allowed`.

## Edge Cases

- Deleted reviewer’s `reviewOf` is inert: it neither constrains reviewer
  transitions nor blocks writer deletion nor pins writers in `clearCompleted`.
- Reviewer reviewing a deleted writer: existence holds; the deleted writer is
  never `completed`, so reviewer `in_progress` stays blocked.
- Reviewer chains (reviewer-of-reviewer): eligibility stays directional (each
  reviewer gated on its own writers); S8 presentation acceptance applies to
  the directly reviewed writer even under an active upper reviewer;
  `clearCompleted` follows transitive `reviewOf` from survivors.
- Writer completed before reviewer exists: allowed; the later reviewer is
  gated on the already-completed writer, and writer transitions are never
  re-gated by the new reviewer.
- Empty `reviewOf` behaves exactly as today.

## Invariants

- I1: `reviewOf` is always an array of positive safe integers owned by the
  reviewer; never persisted refs.
- I2: No non-deleted writer is covered by more than one non-deleted reviewer.
- I3: No dangling `blockedBy` or `reviewOf` edge after any mutation or
  `clearCompleted`.
- I4: `deleted` tasks never gain new `eff` constraints from their own
  `reviewOf`.

## Compatibility

- Old stores/history without `reviewOf` load as `[]`; writes always emit
  `reviewOf`. Envelope version unchanged.
- Legacy glyph config (`glyphs.<status>.character`) keeps working; new keys
  merge with defaults per field with warn-and-fallback.

## Acceptance Criteria

- A1: Creating a reviewer with `reviewOf: [W]` and entering it `in_progress`
  before `W` is completed fails with E6; after `W → completed` it succeeds.
- A2: `reviewOfRefs` batch (writer + reviewer in one `task_create`) allocates
  IDs, links the reviewer to the writer, and orders writer before reviewer.
- A3: Second non-deleted reviewer for the same writer is rejected (E4);
  after deleting the first reviewer, the second succeeds.
- A4: Writer `in_progress` is gated only by its own `blockedBy` (reviewer
  state never blocks it); reviewer `in_progress` requires its writers
  completed. A completed reviewer marks its directly reviewed writer accepted
  `●` even while that reviewer itself awaits another review (presentation
  only).
- A5: `clearCompleted` with reviewer `R(reviewOf:[W])` surviving keeps
  completed `W`; with no surviving reviewer, `W` is removed and no dangling
  `reviewOf` remains; transitive chains are preserved by fixed point.
- A6: Deleted reviewer neither blocks writer deletion (E7 review arm) nor
  pins writers on `clearCompleted`.
- A7: Glyph defaults render as R7; static surfaces use first `in_progress`
  frame; header counts unchanged; legacy custom `inProgress.character` still
  blinks same-width; new config keys override defaults.
- A8: Old persisted file without `reviewOf` loads with `reviewOf: []`.
- A9: `npm run typecheck` passes; `npm test` shows no new failures beyond the
  known unrelated `test/tools.test.ts` prompt-string baseline (328/329).
