# Specification — Assignment Model

## Behavior

- S1: Assignment is absent or exactly `{ delegate: false, owner: null }` or `{ delegate: true, owner: string }`; unknown nested properties and other combinations reject.
- S2: Create accepts an optional whole assignment. Update omission preserves, an object replaces the whole assignment, and `null` removes it.
- S3: A delegated owner is preserved exactly as supplied when it is a non-empty string. Pi-tasks does not discover, canonicalize, or validate the owner against runtime agent registries.
- S4: Create, update, removal, persisted hydration, and unrelated updates do not inspect agent directories or require an owner resolver.
- S5: `enableAssignment` defaults false and solely gates schemas, inline prompt wording (no standalone Assignment section), and display.
- S6: No assignment has no label; direct displays `@self`; delegated displays `@<supplied owner>`. Rendering does not mutate model data.
- S7: Persisted tasks use only `assignment`; an `assignee` field is rejected by persisted-schema key validation for active tasks and history.
- S8: Tool schemas accept only `assignment`; extra `assignee` input fails additional-property validation.
- S9: Assignment remains planning metadata and has no execution side effects.

## Acceptance Criteria

- A1: Direct/delegated valid cases and structural invariant errors are tested.
- A2: Arbitrary non-empty delegated owners are preserved without runtime discovery, including atomically in batches.
- A3: Preserve/replace/remove, enabled/disabled config, and display labels are tested.
- A4: Persisted-schema rejection of `assignee` and assignment-aware cloning/diffs are tested.
- A5: Full tests, typecheck, lint, formatting, and diff whitespace validation pass.
