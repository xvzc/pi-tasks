# Design — 008 Configurable Assignee

## Approach

Smallest change honoring the contract: one boolean on the config, one
conditional spread per tool schema, one conditional prompt section, and
config threading through the three presentational layers. No new modules,
no schema factories, no store changes.

## Changes

- `src/config.ts`: `enableAssignee: boolean` on `PiTasksConfig`,
  `DEFAULT_CONFIG.enableAssignee = false`, `ROOT_KEYS += "enableAssignee"`,
  `cloneConfig` copies it, loader branch accepts booleans else warns with
  the existing `using default … expected … got …` phrasing (S1).
- `src/index.ts`:
  - Module-level `TASK_MANAGEMENT_ASSIGNMENT_SECTION` plus
    `CreateCommonProperties` / `CreateAssigneeProperty` and
    `UpdateCommonProperties` / `UpdateAssigneeProperty` (S2, S3, S8).
  - Registration builds `TaskCreateParams` / `TaskUpdateParams` via
    conditional spread (asserted to the combined property type so
    `Static<>` handler params stay precise), and `taskManagementPrompt`
    with conditional owners/ownership words plus the optional Assignment
    section; `before_agent_start` keeps selectedTools gating and
    duplicate-block protection (S2, S3, S8, S9).
- `src/widget.ts`: `assigneeColumnWidth(tasks, config)` gates on
  `config.enableAssignee`; `formatTaskLine` / `renderWidgetLines` suppress
  assignee text under a disabled config (S4).
- `src/tasks-ui.ts`: `buildTaskDetailLines(task, config)` gates the
  Assignee row; viewer threads its resolved config into detail rendering
  (S5).
- `src/tool-rendering.ts`: `renderTaskGet` gates the Assignee line;
  `renderTaskUpdate` filters `assignee` from displayed diffs unless
  enabled; `semanticDiff` untouched (S6).
- `src/store.ts`, `src/types.ts`: untouched (S7).
- `README.md`: config example + `enableAssignee` bullet; conditional
  `assignee` notes in Tools, Command, and Widget sections (R10).
- Tests: `test/assignee-config.test.ts` (R12) plus intentional default
  updates pinning the enabled config in widget, tasks-ui, tool-rendering,
  tools, unlimited, and paused suites; `test/config.test.ts` gains
  default/true/invalid cases.

## Alternatives Considered

- Separate schema factory functions: rejected — the contract forbids them;
  conditional spread at registration is smaller.
- Stripping/rejecting `assignee` in tool execute paths when disabled:
  rejected — the approved hiding scope is the schema boundary, and store
  compatibility must stay intact for direct/programmatic callers.
- Filtering `assignee` inside `semanticDiff`: rejected — the diff is
  store-level truth; only its human rendering is gated.

## Traceability

R1→S1, R2→S2, R3→S3/S8, R4→S4/S5/S6, R5→S2/S3/S4/S5/S6, R6→S2,
R7→S6/S7, R8→S8, R9→S2, R10→README, R11→this directory, R12→tests,
R13→S7.
