# Turn-start Completed-list Rollover

> Completed-record persistence and schema details are defined by
> `../004-completed-cycle-history/spec.md`.

## Behavior

- `session_start` must restore the current active store without modifying it.
- On the next `turn_start`, a non-empty completed/deleted-only active list must be atomically moved to history before the widget refreshes.
- Active tasks and timing reset while archived records and `nextId` remain preserved.
- Lists containing any `pending`, `in_progress`, or `failed` task must remain unchanged.
- `task_create` performs the same archival rollover as a fallback when creation occurs without a preceding turn start.
- Rollover failure must not break lifecycle handling or partially mutate in-memory state.

## Acceptance Criteria

- A completed/deleted-only active list is visible during session restoration and becomes archived on the next turn start.
- The Tasks widget is cleared by that turn-start refresh.
- The next successful `task_create` continues with the preserved next task ID.
- Mixed/non-completed lists survive turn start.
- Type checking and focused lifecycle/store/tool tests pass.
