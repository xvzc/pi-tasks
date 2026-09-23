# Stable Task Widget Registration

## Behavior

- While a non-empty task widget remains mounted for the same session and UI context, task refreshes must update the mounted component without calling `setWidget()` again.
- The mounted component must render the latest task snapshot and active timing after task mutations and lifecycle refreshes.
- Entering or leaving the `in_progress` state must start or stop the widget redraw timers without replacing the widget.
- An empty task list must remove a mounted task widget.
- A new session/UI context, host disposal, or host invalidation must allow the widget to be registered again.

## Acceptance Criteria

- Consecutive `session_start`/`turn_start` refreshes for the same non-empty session produce one widget registration.
- Creating or updating tasks while the widget is mounted does not re-register it, and rendered output reflects the update.
- Existing widget rendering, lifecycle restoration, timer cleanup, type checking, and tests continue to pass.

## Non-goals

- Changing Pi host widget ordering semantics.
- Pinning widget order after the Tasks widget is removed because the task list becomes empty and is later recreated.
