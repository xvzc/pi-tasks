# Tasks — Task Tool Rendering

> Historical `task_delete` work below is superseded by
> `.specs/005-deleted-task-status/spec.md`.

## T1. Rendering module skeleton + shared helpers

- [x] Create `src/tool-rendering.ts` with `CollapsedExpanded` type, `sanitizeText`, `truncateToWidth`, `boundedPreview`, `pluralizeTask` (singular/plural substitution; never emit literal `task(s)`), and `renderTaskToolError` skeleton emitting exactly the five S7 lines (sanitized expected vs. masked unexpected).
- [x] No schema/handler return-value changes.

Satisfies:

- S1, S7, S8
- A6, A7
- D1, D2, D4

## T2. Create / get / list / delete formatters (exact strings)

- [x] Implement `renderTaskCreate` (`✓ Created N task(s)` substituted + `#id title` rows).
- [x] Implement `renderTaskGet` (`✓ Retrieved task #N` + core operational view: latest 3 logs chronological, `—` for absent assignee/dependencies/log, attempts `current/max` or `current/unlimited`, bounded previews, omit metadata/timestamps).
- [x] Implement `renderTaskList` (`✓ Listed N task(s)[ · status: X]` substituted + `#id title → status` rows in tool sort order; `○ No tasks[...]` non-error empty state).
- [x] Implement `renderTaskDelete` (`✓ Deleted task #N`; pre-delete subject only on success).

Satisfies:

- S1, S2, S4, S5, S6
- A1, A3, A4, A5
- D1, D2

## T3. Update formatter with snapshot semantic diff

- [x] Implement `semanticDiff` (captured pre-update snapshot vs. final state; exclude derived lifecycle/timing fields) and `renderTaskUpdate` (`✓ Updated N task(s)` substituted + `#id final subject → changed fields`).
- [x] Enforce exact fixed order `status, subject, description, assignee, dependencies, metadata, log`; normalize `blockedBy→dependencies`, `appendLog→log`; emit `→ no changes` on empty diff.

Satisfies:

- S3
- A2
- D3

## T4. Minimal `src/index.ts` handler/result-helper integration

- [x] Attach each formatter as presentation-only `details` and `renderResult` collapsed/expanded; the original static `renderCall` behavior was superseded by T7/T8. No progress callbacks.
- [x] Capture pre-update snapshots for diffs and pre-delete `{id,subject}` for the success path.
- [x] Verify tool names, schemas, handler return values, and model JSON/error text are untouched.

Satisfies:

- S1, S9
- A6, A8
- D2, D5

Depends on:

- T1
- T2
- T3

## T5. Focused tests (exact-string assertions)

- [x] Add focused tests asserting verbatim collapsed strings (with singular/plural substitution; no literal `task(s)`), verbatim `renderCall` strings, `#id title → status` list rows, get semantics (3-log chronological order, `—` placeholders, attempts formats, bounded previews), diff order/aliases/`no changes`/derived-field exclusion, delete title-on-success-only, the five exact `✗ Failed to ...` lines with N from args (no generic `task_* failed` forms), width/control-char safety, and model-output passthrough unchanged.

Satisfies:

- A1, A2, A3, A4, A5, A6, A7, A8

Depends on:

- T4

## T6. Verification evidence

- [x] Run focused tests, full `npm test`, and `npm run typecheck`, and record results in `verification.md` mapped to A1–A8. (No lint script exists; do not claim lint.) Full suite has one pre-existing unrelated workflow-policy assertion failure; see verification evidence.

Satisfies:

- A1, A2, A3, A4, A5, A6, A7, A8

Depends on:

- T5

## T7. Themed spinner `renderCall` + settled output themes (refinement)

- [x] Update `renderCall` for all five tools to the animated spinner with exactly the count-free generic labels `Creating tasks…`, `Updating tasks…`, `Retrieving task…`, `Listing tasks…`, `Deleting task…` (no IDs, counts, or filters in the loading label), including with partial args present.
- [x] Apply settled themes: `✓` in `success`, success summary text in `toolTitle`, every expanded detail line in `toolOutput`; failures in `error` (glyph/summary), empty `○` indicator in `dim`, detail text in `toolOutput` unless safety requires otherwise; preserve plain semantic strings for non-themed/fallback modes.
- [x] Implement the original S12 spinner lifecycle and stable-`toolCallId` recovery; superseded for pending/settled visibility by T8.
- [x] Add acceptance and verification coverage for: theme calls (`success`/`toolTitle`/`toolOutput`/`error`/`dim`), details color parity, count-free labels, frame advancement, spinner reuse, stop behavior, partial args, theme failure/plain fallback, and no timer leaks after settlement.

Satisfies:

- R10, R11, R12
- S10, S11, S12
- A9, A10, A11
- D6

Depends on:

- T4
- T5

## T8. User-acceptance spinner visibility and loading-row replacement

- [x] Animate from the start of normal interactive `isPartial === true`, including before `executionStarted`, while retaining a static safe fallback without a stable `toolCallId`; export/replay creation behavior was subsequently refined by T9.
- [x] On `isPartial === false`, stop every recoverable spinner, clear state/registry, and return a documented zero-height empty `Container`; retain defensive cleanup in `renderTaskResult`.
- [x] Add fake-timer and host-order composition coverage for initial visibility/frame advance, zero-line settlement, all five tools replacing loading text with themed results, and zero cleanup residue.
- [x] Preserve count-free labels, stale/timer safety, theme mapping, model contracts, default shell, plain/non-context fallback, and no `onUpdate` use.
- [x] Update README and verification evidence and run focused rendering, focused integration/registration, typecheck, and full suite.

Satisfies:

- R10, R11, R12
- S10, S11, S12
- A9, A10, A11
- D6

Depends on:

- T7

## T9. Export/replay-safe spinner creation

- [x] Create new spinner/timer/registry state only during normal pre-execution pending (`executionStarted !== true`); after execution starts, only continue or recover an existing spinner.
- [x] Return a zero-height empty `Container` when an execution-started partial render has no prior spinner, preserving settlement cleanup and result-side defensive cleanup.
- [x] Add actual Pi 0.85.1 `createToolHtmlRenderer` tests proving all five completed exports omit loading labels/spinner frames while retaining results, result-less call export creates no timer, and cleanup remains zero.
- [x] Preserve real `ToolExecutionComponent` spinner visibility, themes, count-free labels, fallbacks, model contracts, default shell, and no `onUpdate` use.
- [x] Update README/specification/verification and run focused rendering, focused integration/registration, typecheck, and full suite.

Satisfies:

- R10, R11, R12
- S10, S11, S12
- A9, A10, A11
- D6

Depends on:

- T8

## T10. Pending spinner/label host-theme styling (final refinement)

- [x] Thread the host theme from all five `renderCall` registrations into the shared spinner/helper: spinner frame in theme `accent`, pending label (animated and static fallback) in theme `toolTitle`.
- [x] Keep ANSI-aware width safety (truncate the plain label before theming; themed ANSI adds no visible width; `Text` wraps ANSI-aware) and refresh the theme on every reused spinner update.
- [x] Preserve settled styling exactly (`✓` success, summary toolTitle, details toolOutput, failures error, empty dim), spinner lifecycle, zero-height settlement, toolCallId cleanup, export/replay omission, default shell, model/schema/error contracts, and no onUpdate; plain/no-theme/theme-throw fallbacks keep the exact unstyled pending string and animation.
- [x] Add focused tests for theme call sequence/colors on static and animated pending labels for all five tools, frame advance, reused component/theme changes, theme failure fallback, settlement/export behavior, and no regressions.
- [x] Update README/spec artifacts and run focused renderer, focused registration/integration, typecheck, and full suite.

Satisfies:

- R10, R11, R12
- S10, S11, S12
- A9, A10, A11
- D6

Depends on:

- T9
