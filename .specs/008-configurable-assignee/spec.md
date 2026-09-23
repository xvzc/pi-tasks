# Specification — 008 Configurable Assignee

## Behavior

- S1: `PiTasksConfig` gains `enableAssignee: boolean`; `DEFAULT_CONFIG`
  sets it `false`. `loadPiTasksConfig` accepts only booleans and otherwise
  warns (`expected a boolean`) and keeps `false`; unknown root keys still
  warn individually; missing file/fields fall back silently to defaults
  (R1).
- S2: Registration builds `taskManagementPrompt` from the loaded config:
  `false` renders Initial Materialization as "meaningful deliverables,
  acceptance checks, and actual dependencies" and the plan-fidelity sentence
  as "its scope, dependencies, or acceptance criteria", with no Assignment
  section; `true` renders "meaningful deliverables, owners, acceptance
  checks, and actual dependencies", "its scope, ownership, dependencies, or
  acceptance criteria", plus the Assignment section (R2, R6, R9).
- S3: `task_create` items expose `assignee` if and only if `enableAssignee`
  is `true`; likewise `task_update` items (`string|null`, "null to remove").
  Both item objects keep `additionalProperties: false`, and the top-level
  create params keep it too (R3).
- S4: Widget: `assigneeColumnWidth(tasks, config)` returns `0` unless
  `config.enableAssignee` is `true`; `formatTaskLine` and
  `renderWidgetLines` emit no `@assignee` text (and no reserved width, even
  when an explicit assignee width is passed) unless enabled. All other
  columns, glyphs, colors, durations, and header behavior are unchanged
  (R4, R5).
- S5: Viewer: `buildTaskDetailLines(task, config)` includes the Assignee row
  only when enabled; `createTasksViewer` threads its resolved config into
  both the detail-lines helper and the visible detail slice. Row labels
  never carried assignee and are unchanged (R4, R5).
- S6: Tool rendering: `renderTaskGet` includes the Assignee line only when
  enabled; `renderTaskUpdate` filters the `assignee` entry out of the
  displayed semantic diff unless enabled. `semanticDiff` itself still
  reports `assignee` (store-level truth for programmatic use) (R4, R5, R7).
- S7: Store (`src/store.ts`, `src/types.ts`): unchanged. `assignee?: string`
  persists, `assignee: null` removes, prefix/color guards stay, and no
  migration or rewrite is triggered by config (R7, R13).
- S8: Schemas are built from module-level `CreateCommonProperties` /
  `CreateAssigneeProperty` and `UpdateCommonProperties` /
  `UpdateAssigneeProperty` with a registration-time conditional spread; the
  spread result is asserted to the combined property type so handler
  `Static<>` params keep `assignee?: string` / `assignee?: string|null`
  without `any` (R8).

## Inputs

- `PiTasksConfig.enableAssignee`: `boolean | undefined` on disk; invalid
  values warn and fall back to `false`.
- Tool params at runtime: host-validated against the registered
  (config-gated) schema; handlers tolerate the store input shapes either
  way.

## Outputs

- Disabled: schemas without `assignee`; prompt without owners/Assignment;
  widget lines, viewer details, and get/update renderings without assignee
  content or reserved alignment.
- Enabled: byte-identical assignee behavior to the pre-change baseline.
- Both: store files and raw JSON payloads keep persisted assignee data.

## Errors

- E1: non-boolean `enableAssignee` warns:
  `pi-tasks: invalid config at <path>, using default enableAssignee (false):
  expected a boolean, got <json>.`
- No new tool/store errors; schema violations remain host-side.

## Edge Cases

- Persisted tasks with `assignee` load, list, get, and save unchanged while
  disabled; re-enabling redisplays them with original alignment.
- Direct store writes carrying `assignee` while disabled still persist
  (schema gating is a tool boundary, not a store filter).
- Explicit `assigneeWidth` passed to `formatTaskLine` under a disabled
  config still renders no assignee column.

## Invariants

- I1: Disabled human-facing surfaces (prompt, schemas, widget, viewer,
  get/update renderings) never contain assignee/owner guidance, an
  `assignee` schema property, `@assignee` text, or reserved assignee width.
- I2: No store write occurs solely because of the flag value.
- I3: Enabled mode preserves the baseline assignee contract exactly.

## Compatibility

- C1: v1/v2 envelopes with `assignee` load and rewrite unchanged.
- C2: Configs without `enableAssignee` load silently as `false`; configs
  with invalid values warn per-field and keep `false`.

## Acceptance Criteria

- A1: `npm test` passes 18 files / all tests; `npm run typecheck` passes.
- A2: Grep audit: disabled prompt/render/schema paths show no assignee
  leakage; store/types show no config gating.
- A3: R12 coverage exists and previously assignee-asserting suites pin the
  enabled config explicitly.
