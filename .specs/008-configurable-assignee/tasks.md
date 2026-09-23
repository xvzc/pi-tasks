# Tasks — 008 Configurable Assignee

- [x] T1: `enableAssignee` config flag with warn-and-fallback (`src/config.ts`).
- [x] T2: Module-level common/assignee property objects + registration-time
      conditional schemas; registration-time prompt with conditional
      Assignment section (`src/index.ts`).
- [x] T3: Config-gated assignee display, widths, detail rows, get/update
      renderings (`src/widget.ts`, `src/tasks-ui.ts`,
      `src/tool-rendering.ts`); store/types untouched.
- [x] T4: README config example and conditional assignee behavior docs.
- [x] T5: `test/assignee-config.test.ts` (schemas, prompt, widget, viewer,
      tool rendering, persisted-data compatibility).
- [x] T6: Intentional default updates in config, widget, tasks-ui,
      tool-rendering, tools, unlimited, paused suites.
- [x] T7: This spec directory (requirements, spec, design, tasks,
      verification).
- [x] T8: Full `npm test` + `npm run typecheck`; leakage self-inspection.
