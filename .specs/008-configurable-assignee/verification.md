# Verification — 008 Configurable Assignee

## Commands (actual, current workspace)

- `npm run typecheck` → pass (`tsc --noEmit`, no output).
- `npm test` → pass: `Test Files 18 passed (18)`, `Tests 364 passed (364)`.
- Focused: `config + tools + widget + tasks-ui + tool-rendering +
  session-start + assignee-config` → 7 files / 183 tests pass.
- Baseline per assignment: 17 files / 346 tests passing, typecheck
  passing. Net change: +1 file (`test/assignee-config.test.ts`, 14 tests),
  +4 tests in existing suites (3 config, 1 tools).

## Scope Checks

- Config: default `false` (missing file/fields, silent); `true` accepted;
  non-boolean warns (`expected a boolean`) and keeps `false`; unknown root
  keys still warn individually.
- Schemas: disabled create/update items have no `assignee` property with
  `additionalProperties: false` intact on both item objects (so a disabled
  `assignee` is rejected by schema validation, not merely omitted) and on
  the top-level create params; enabled exposes
  `create assignee?: string` ("Assigned owner or agent") and
  `update assignee?: string|null` ("null to remove").
- Status contract: the `Status` description retains the approved
  `Every real status transition requires a non-empty appendLog.` sentence.
- Prompt: disabled block contains no `assignee`/`owners`/`ownership`/
  `Assignment` wording; enabled keeps owners wording and adds the concise
  Assignment section (known owner only; ownership record only, no
  dispatch/start/authorization; do not invent; `null` removes).
  Duplicate-block protection and `task_create` selectedTools gating hold in
  both modes (covered).
- Display: disabled widget (plain + themed, incl. explicit-width call),
  viewer details/overlay, get rendering, and update diffs hide assignee
  with zero reserved width; enabled output matches the pre-change baseline
  (pinned via explicit enabled config in existing suites).
- Compatibility: raw JSON payloads keep persisted `assignee` while
  disabled; human renderings hide it; re-enabling redisplays it; no store
  write occurs solely due to the flag; `semanticDiff` still reports
  `assignee` while its rendering is gated.
- Leakage audit (`grep -rn -i "assignee|owners|ownership|Assignment"
  src/`): every human-facing occurrence is behind
  `config.enableAssignee`; remaining bare occurrences are store persistence
  (`store.ts`/`types.ts`, untouched), `semanticDiff` truth, and schema
  property definitions consumed only through the conditional spread.

## Limitations

- No orchestration task records created or updated (per output contract).
- Host-side schema enforcement assumed: direct programmatic `execute`/store
  calls carrying `assignee` while disabled still persist (intended
  store-compat behavior, covered by test).
- Concurrent multi-process writers still last-rename-wins (pre-existing,
  unchanged).
