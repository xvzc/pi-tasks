# Requirements — 006 Task Reviews

## Goal

Enable acceptance-review workflows where a review task depends on one or more
writer tasks, executes after they complete, and marks them accepted in
presentation, without changing existing dependency behavior for tasks that do
not use reviews.

## Functional Requirements

- R1: A task may carry a `reviewOf: number[]` list identifying writer tasks it
  reviews; it defaults to `[]` and old persisted stores load as `[]`.
- R2: `task_create` and `task_update` must support setting `reviewOf`
  (replacement semantics on update), plus request-local `reviewOfRefs` for
  atomic batch creation.
- R3: At most one non-deleted review task may reference a given writer task;
  one non-deleted review task may reference many writers; deleted reviewers
  are inert.
- R4: `reviewOf` belongs to the reviewer and creates writer→reviewer
  prerequisite edges (reviewer execution is gated on its writers). Preserve
  `effectivePrereqs` for reviewer execution and graph validation: the
  de-duplicated order-preserving union of `blockedBy` then `reviewOf`
  (deleted tasks' `reviewOf` is inert). Writers do not include reviewers in
  their own effective prerequisites.
- R5: A reviewer may enter or remain `in_progress` only when its writers are
  `completed`; a writer is gated only by its own `blockedBy`. A completed
  reviewer causes its directly reviewed writer to render accepted `●`, even
  if that reviewer itself has an active reviewer; this is presentation
  approval, not writer transition gating.
- R6: `clearCompleted` must preserve completed writers referenced directly or
  transitively by surviving non-deleted review tasks (fixed-point), create no
  dangling `reviewOf`, and otherwise keep existing manual-clear behavior.
- R7: Presentation must distinguish review states with defaults: fresh pending
  `◌`, retried pending `■`, failed `✕`, deleted `⌫` (plus current
  strikethrough), completed awaiting its active reviewer `○`, other completed
  `●` (including accepted writers), `in_progress` frames `◌ ○ ⨀ ◉ ● ◉ ⨀ ○ ◌`
  at current 250 ms; static surfaces use the first frame. Header status counts
  remain based on actual `status`.
- R8: Glyph configuration must extend normalized config with
  `pending.retriedCharacter`, `completed.awaitingReviewCharacter`, and
  `inProgress.frames`; legacy per-status `character` overrides remain
  effective, including legacy custom `inProgress` character retaining
  same-width blink.

## Non-Functional Requirements

- N1: All review mutations remain atomic with existing final-state semantics;
  persistence failures leave in-memory state unchanged.
- N2: Existing transition behavior and error ordering are preserved; lifecycle
  side effects remain in the store behind a pure status-transition
  eligibility helper.

## Constraints

- C1: Store envelope version and file layout are unchanged; `reviewOf` loads
  with `[]` default and writes always emit it.
- C2: `reviewOf` is an intentional tool/data contract addition (`Task` field
  plus `task_create`/`task_update` parameters); no other tool, release, or
  migration commitments are made.

## Non-Goals

- Automatic reviewer assignment, review scoring, or multi-reviewer voting.
- Changes to attempt counting, timing, history archiving, or `clearAll`.
- New tools, CLI commands, or viewer interactions beyond glyph/suffix display.
- Migration of persisted history cycles beyond `reviewOf`-as-`[]` loading.

## Assumptions

- Existing `blockedBy` semantics (existence, self-reference, cycle,
  topological batch ordering, deletion protection, pending display) apply
  unchanged to reviewer effective prerequisites.
- `deleted` remains terminal and inert for review edges, matching `blockedBy`.
- Known unrelated baseline: typecheck passes; `npm test` has 328/329 passing
  with existing `test/tools.test.ts` prompt-string failure, out of scope.

## Traceability

- R1 → S1, S2; R2 → S3, S4; R3 → S5; R4 → S6; R5 → S7, S8; R6 → S9;
  R7 → S10, S11; R8 → S12; N1 → S13; N2 → S14, D4.
