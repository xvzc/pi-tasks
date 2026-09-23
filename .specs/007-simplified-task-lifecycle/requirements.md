# Requirements — 007 Simplified Task Lifecycle

## Goal

Replace the `failed` status with `paused` and reduce the lifecycle to a small
explicit graph in which every real status transition carries a non-empty
`appendLog`. Preserve atomic batch semantics, timing behavior, dependency
invariants, storage safety, and review relations.

## Requirements

- R1: `TaskStatus` is `pending | in_progress | paused | completed | deleted`.
  `failed` is removed from the type, guards, tool schemas, config, and UI.
- R2: Allowed real transitions (single immutable adjacency map):
  `pending → in_progress | deleted`,
  `in_progress → paused | completed`,
  `paused → in_progress | deleted`,
  `completed → in_progress`,
  `deleted → none`.
  Same-status patches are allowed and are not transitions.
- R3: Every real status transition requires a non-empty `appendLog`
  (start, pause, resume, completion, rework, deletion). Same-status patches
  need no log.
- R4: Entry to `in_progress` keeps the completed-prerequisite and
  attempt-limit checks. Every non-`in_progress` → `in_progress` increments
  `attempt` (initial start, resume, rework).
- R5: `reviewOf` stays relational. Rework is reviewer `in_progress → paused`
  plus writer `completed → in_progress` in one atomic batch; when the writer
  completes again, reviewer `paused → in_progress`.
- R6: `pending` is initial-only after migration. `paused → deleted` is
  allowed. `completed → in_progress` is the rework route. `deleted` is
  terminal.
- R7: Legacy persisted compatibility: map legacy `failed` to `paused`; map
  legacy `pending` with `attempt > 0` to `paused`. Legacy `pending` with
  `attempt` 0 stays `pending`. Never corrupt or reject a readable v1/v2
  store solely for old `failed`/`pending` semantics.
- R8: Keep atomic batch final-state semantics, timing behavior, dependency
  invariants, storage safety, and unrelated behavior intact.
- R9: Update all public schemas, tool descriptions, prompt text, UI,
  rendering, docs, and affected tests.
- R10: Legacy `failed` glyph config keys load with a warning and map to
  `paused` rather than crashing.
