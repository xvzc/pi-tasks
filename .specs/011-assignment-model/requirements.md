# Requirements

## Goal

Replace optional string assignees with invariant-preserving, planning-only assignment metadata.

## Functional Requirements

- R1: A task may have no assignment, direct assignment, or delegated assignment.
- R2: A delegated owner must be a non-empty string; runtime owner discovery and agent selection are owned by the subagent extension, not pi-tasks.
- R3: Assignment metadata must never execute, dispatch, resume, or authorize work.
- R4: Create/update schemas, persistence, rendering, prompts, config, and documentation use `assignment` and `enableAssignment` only.
- R5: Persisted tasks use only `assignment`; an `assignee` field is rejected by current-schema validation.

## Constraints

- Changes stay in pi-tasks and do not import, inspect, or modify pi-subagents or its agent directories.
- Static schemas do not enumerate or validate runtime owners beyond requiring a non-empty string.
- Existing unrelated edits and specifications 009/010 remain intact.
