# Terminal-cycle History

## Behavior

- Persisted stores use a version-2 envelope containing active `tasks` and an append-only `history` of completed/deleted terminal cycles.
- Version-1 envelopes remain readable and are upgraded on their next successful write.
- Each archived cycle stores its archive timestamp, terminal task snapshots (including metadata and logs), and accumulated active time.
- When `turn_start` encounters a non-empty completed/deleted-only active list, it atomically appends that cycle to history, clears active tasks and timing, and preserves `nextId`.
- When `task_create` directly encounters a completed/deleted-only active list, it archives the old cycle and creates the new batch in the same atomic write while preserving monotonic ID allocation.
- Manual `clearAll` continues to clear only active tasks and does not erase previously archived history.
- Mixed active lists are never archived automatically.

## Acceptance Criteria

- Archived task details and logs remain in the same session file after automatic turn-start cleanup.
- The next task ID continues from the persisted `nextId` after archival.
- Multiple completed cycles append to history without overwriting earlier cycles.
- Invalid version-2 history, including non-terminal archived statuses, is rejected without mutation.
- Existing version-1 files load successfully.
- Type checking and focused store/lifecycle/tool tests pass.

## Non-goals

- Adding history to `task_list`, `/tasks`, or the persistent widget.
- Archiving manually cleared pending, in-progress, or failed tasks.
