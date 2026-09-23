# Deleted Task Status

## Behavior

- The extension registers exactly four task tools: `task_create`, `task_update`, `task_get`, and `task_list`; `task_delete` is removed.
- `deleted` is a persisted task status accepted by `task_update` and `task_list(status)`.
- Entering `deleted` is a terminal soft-delete transition. A deleted task cannot transition to another status, though non-status metadata/log updates may still be applied.
- A task cannot enter `deleted` while any final-state non-deleted task references its ID. An atomic batch may mark both a dependent and its dependency deleted.
- Leaving `in_progress` for `deleted` freezes attempt duration and updates global active timing like other terminal transitions.
- Deleted tasks remain visible in `task_list`, `task_get`, `/tasks`, and the persistent widget. The widget renders them dimmed with strikethrough and reports a deleted count.
- A non-empty active cycle is archivable when every task is either `completed` or `deleted`; both statuses are retained in the same history cycle.
- Manual `clearCompleted` does not remove deleted tombstones; `clearAll` still removes all active tasks.

## Acceptance Criteria

- No `task_delete` tool, schema, prompt reference, or delete-specific renderer remains.
- Updating an unreferenced task to `deleted` preserves its record and logs on disk.
- Referenced soft-deletes are rejected unless all final-state referencers are also deleted in the same atomic update.
- Deleted tasks cannot be reactivated.
- Completed/deleted-only cycles archive on turn start and preserve monotonic IDs.
- Type checking and focused model/store/tool/widget/UI tests pass.
