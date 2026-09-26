/**
 * pi-tasks — per-main-session task tracking for Pi.
 *
 * Tools (exactly these four; no convenience, dependency, delete, or subagent tools):
 *   task_create, task_update, task_get, task_list
 *
 * The tools are registered by the host/main Pi extension context only. This
 * extension implements no shared or subagent stores: every store is a
 * per-main-session file under `<cwd>/.pi/tasks/`, and subagents must not use
 * these tools.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  DEFAULT_CONFIG,
  loadPiTasksConfig,
  type PiTasksConfig,
} from "./config.js";
import { TaskError, TaskStore, taskFilePath, turnStartStore } from "./store.js";
import { createTasksViewer } from "./tasks-ui.js";
import {
  renderTaskCall,
  renderTaskCreate,
  renderTaskGet,
  renderTaskList,
  renderTaskResult,
  renderTaskToolError,
  renderTaskUpdate,
  taskRenderDetails,
  type TaskToolRenderDetails,
} from "./tool-rendering.js";
import { isTaskStatus, type Task } from "./types.js";
import {
  createTaskWidget,
  type ActiveTiming,
  type TaskWidgetComponent,
  type ThemeLike,
  type TuiWidthLike,
} from "./widget.js";

const WIDGET_KEY = "tasks";
const TASK_MANAGEMENT_TAG = "task-management";
const TASK_MANAGEMENT_TAG_START = `<${TASK_MANAGEMENT_TAG}>`;
const TASK_MANAGEMENT_TAG_END = `</${TASK_MANAGEMENT_TAG}>`;

const TaskId = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: "Numeric task ID.",
});
const CreateBlockedBy = Type.Array(TaskId, {
  description:
    "IDs of tasks whose outputs are required before this task can start. Referenced tasks must already exist.",
});
const UpdateBlockedBy = Type.Array(TaskId, {
  description:
    "Replacement dependency list. Every referenced task must already exist.",
});
const CreateReviewOf = Type.Array(TaskId, {
  description:
    "IDs of existing writer tasks reviewed by this task. Writers are effective prerequisites; do not duplicate in blockedBy.",
});
const UpdateReviewOf = Type.Array(TaskId, {
  description:
    "Replacement list of writer task IDs reviewed by this task. Writers are effective prerequisites; do not duplicate in blockedBy.",
});
const CreateMetadata = Type.Record(Type.String(), Type.Unknown(), {
  description: "Free-form task metadata. Never include secrets.",
});
const UpdateMetadata = Type.Record(Type.String(), Type.Unknown(), {
  description: "Values to shallow-merge into the existing metadata.",
});
const Status = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("paused"),
    Type.Literal("deleted"),
  ],
  {
    description:
      "Allowed transitions: pending -> in_progress|deleted; in_progress -> paused|completed; paused -> in_progress|deleted; completed -> in_progress; deleted is terminal. Every real status transition requires a non-empty appendLog. Entering or remaining in_progress requires all effective prerequisites to be completed. Deletion is refused while a non-deleted task references it.",
  },
);

const TaskListStatus = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("paused"),
    Type.Literal("deleted"),
  ],
  {
    description: "Filter by lifecycle status.",
  },
);

const TaskRef = Type.String({
  pattern: "^[a-z][a-z0-9_-]*$",
  description:
    "Request-local task reference slug. Used only within this batch and never persisted.",
});

const CreateCommonProperties = {
  ref: Type.Optional(TaskRef),
  subject: Type.String({ description: "Short, specific task title." }),
  description: Type.String({
    description:
      "Task detail. Include scope, expected output, acceptance checks, and relevant constraints or stop conditions. Write in English unless governing instructions require another language. Never include secrets.",
  }),
  blockedBy: Type.Optional(CreateBlockedBy),
  blockedByRefs: Type.Optional(
    Type.Array(TaskRef, {
      description:
        "Request-local refs of tasks in this batch whose outputs are required before this task can start.",
    }),
  ),
  reviewOf: Type.Optional(CreateReviewOf),
  reviewOfRefs: Type.Optional(
    Type.Array(TaskRef, {
      description:
        "Request-local refs of writer tasks in this batch reviewed by this task. Writers are effective prerequisites; do not duplicate in blockedByRefs. Never persisted.",
    }),
  ),
  metadata: Type.Optional(CreateMetadata),
};

const AssignmentSchema = Type.Union(
  [
    Type.Object(
      {
        delegate: Type.Literal(false),
        owner: Type.Null(),
      },
      { additionalProperties: false },
    ),

    Type.Object(
      {
        delegate: Type.Literal(true),
        owner: Type.String({
          minLength: 1,
          description:
            "Opaque non-empty subagent type. Runtime availability is validated outside pi-tasks.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      'Planning-only assignment. Direct work uses { delegate: false, owner: null }; delegated work uses { delegate: true, owner: "<subagent type>" }. Pi-tasks preserves delegated owners without runtime discovery and never dispatches work.',
  },
);

const CreateAssignmentProperty = {
  assignment: Type.Optional(AssignmentSchema),
};

const UpdateCommonProperties = {
  id: TaskId,
  subject: Type.Optional(Type.String({ description: "New title." })),
  description: Type.Optional(
    Type.String({
      description:
        "Replacement task definition. Do not use for progress, validation, blockers, rework, pause reasons, or handoffs; use `appendLog` instead.",
    }),
  ),
  status: Type.Optional(Status),
  blockedBy: Type.Optional(UpdateBlockedBy),
  reviewOf: Type.Optional(UpdateReviewOf),
  metadata: Type.Optional(UpdateMetadata),
  appendLog: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Execution note appended with a timestamp. Must be non-blank (trimmed). Use for validation evidence, blockers, review findings, rework requests, pause reasons, and handoffs. Required for every real status transition.",
    }),
  ),
};

const UpdateAssignmentProperty = {
  assignment: Type.Optional(
    Type.Union([AssignmentSchema, Type.Null()], {
      description:
        'Whole replacement planning-only assignment, or null to remove it. Direct is { delegate: false, owner: null }; delegated is { delegate: true, owner: "<subagent type>" }. Pi-tasks preserves delegated owners without runtime discovery and never dispatches work.',
    }),
  ),
};

const TaskGetParams = Type.Object({
  id: TaskId,
});

const TaskListParams = Type.Object({
  status: Type.Optional(TaskListStatus),
});

type ErrorResult = {
  content: [{ type: "text"; text: string }];
  details: TaskToolRenderDetails | undefined;
  isError: true;
};

function textResult(text: string, details?: TaskToolRenderDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(
  text: string,
  details?: TaskToolRenderDetails,
): ErrorResult {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError: true as const,
  };
}

function invalidIdResult(id: unknown): ErrorResult {
  const text = `Invalid task id: ${String(id)}. Expected a positive safe integer.`;
  return errorResult(
    text,
    taskRenderDetails(() => renderTaskToolError("get", text, id, true)),
  );
}

function isValidId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

/** Minimal UI surface used for the persistent task widget. */
interface WidgetUI {
  setWidget(key: string, content: unknown, options?: unknown): void;
}

type WidgetRefresh = (ctx: ExtensionContext, store: TaskStore) => void;

/**
 * Keep one mounted task widget per session/UI context. Store changes update the
 * component snapshot and request a redraw without calling `setWidget()` again,
 * preserving the host's insertion order relative to other extension widgets.
 */
function createWidgetRefresher(
  config: PiTasksConfig = DEFAULT_CONFIG,
): WidgetRefresh {
  let currentUI: WidgetUI | undefined;
  let currentSession: string | undefined;
  let widgetRegistered = false;
  let component: TaskWidgetComponent | undefined;
  let snapshot: Task[] = [];
  let timing: ActiveTiming | undefined;

  return (ctx: ExtensionContext, store: TaskStore): void => {
    try {
      const ui = ctx.ui as unknown as WidgetUI;
      if (!ui || typeof ui.setWidget !== "function") return;

      const session = JSON.stringify([ctx.cwd, sessionIdOf(ctx)]);
      const contextChanged = ui !== currentUI || session !== currentSession;
      if (contextChanged) {
        component?.dispose();
        currentUI = ui;
        currentSession = session;
        widgetRegistered = false;
        component = undefined;
      }

      snapshot = store.list();
      timing = store.activeTiming();
      if (snapshot.length === 0) {
        if (widgetRegistered || contextChanged)
          ui.setWidget(WIDGET_KEY, undefined);
        widgetRegistered = false;
        component = undefined;
        return;
      }

      if (widgetRegistered) {
        component?.update(snapshot, timing);
        return;
      }

      ui.setWidget(
        WIDGET_KEY,
        (tui: unknown, theme: ThemeLike) => {
          const mounted = createTaskWidget(
            snapshot,
            tui as TuiWidthLike,
            theme,
            undefined,
            timing,
            config,
          );
          component = mounted;
          return {
            render: mounted.render,
            invalidate: () => {
              mounted.invalidate();
              if (component === mounted) {
                widgetRegistered = false;
                component = undefined;
              }
            },
            dispose: () => {
              mounted.dispose();
              if (component === mounted) {
                widgetRegistered = false;
                component = undefined;
              }
            },
          };
        },
        { placement: "aboveEditor" },
      );
      widgetRegistered = true;
    } catch {
      component?.dispose();
      component = undefined;
      widgetRegistered = false;
      // Widget updates must never break tool execution or turn handling.
    }
  };
}

/** Load the current session store and safely refresh its mounted widget. */
async function refreshWidgetForSession(
  ctx: ExtensionContext,
  refreshWidget: WidgetRefresh,
  resetCompletedCycle = false,
): Promise<void> {
  try {
    const store = resetCompletedCycle
      ? (await turnStartStore(ctx.cwd, sessionIdOf(ctx))).store
      : await TaskStore.load(taskFilePath(ctx.cwd, sessionIdOf(ctx)));
    refreshWidget(ctx, store);
  } catch {
    // Lifecycle refreshes must never break session startup, reload, resume, or turns.
  }
}

function sessionIdOf(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

/** Centered overlay sizing for the `/tasks` viewer. */
export const TASKS_OVERLAY_OPTIONS = {
  width: "80%",
  maxHeight: "80%",
  anchor: "center",
} as const;

/** Inline `/tasks` menu labels with live counts. */
export function tasksMenuLabels(tasks: Task[]): [string, string, string] {
  const completed = tasks.filter((task) => task.status === "completed").length;
  return [
    `View all tasks (${tasks.length})`,
    `Clear completed (${completed})`,
    `Clear all (${tasks.length})`,
  ];
}

export default function (pi: ExtensionAPI) {
  const config = loadPiTasksConfig();
  const refreshWidget = createWidgetRefresher(config);
  const TaskCreateParams = Type.Object(
    {
      tasks: Type.Array(
        Type.Object(
          {
            ...CreateCommonProperties,
            ...(config.enableAssignment ? CreateAssignmentProperty : {}),
          } as typeof CreateCommonProperties & typeof CreateAssignmentProperty,
          { additionalProperties: false },
        ),
        { minItems: 1, description: "Tasks to create atomically." },
      ),
    },
    { additionalProperties: false },
  );

  const TaskUpdateParams = Type.Object({
    updates: Type.Array(
      Type.Object(
        {
          ...UpdateCommonProperties,
          ...(config.enableAssignment ? UpdateAssignmentProperty : {}),
        } as typeof UpdateCommonProperties & typeof UpdateAssignmentProperty,
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description: "Declarative task patches to apply atomically.",
      },
    ),
  });

  const taskManagementPrompt = `${TASK_MANAGEMENT_TAG_START}

## Scope

Use task_* tools only for authorized work with multiple meaningful execution
steps. Do not create separate tasks for routine inspection, editing, focused
validation, or incidental implementation details of one bounded change.

## Initial Materialization

Before the first task_create call, determine the currently known execution task
set, including meaningful deliverables,${config.enableAssignment ? " assignments," : ""} acceptance checks, and actual
dependencies, then create that set in one atomic batch.

Keep task definitions outcome-oriented and free of incidental implementation
details.

When an active plan exists, task records must reflect that plan without changing
its scope,${config.enableAssignment ? " assignments," : ""} dependencies, or acceptance criteria.

Within one task_create batch, use blockedByRefs for local dependencies and
reviewOfRefs for local review targets; numeric blockedBy/reviewOf are for
existing tasks only. reviewOf is already an effective prerequisite; do not
duplicate the same writer in blockedBy/blockedByRefs.

## Lifecycle

Start pending -> in_progress immediately before work begins. Complete
in_progress -> completed only after the deliverable and required checks are
satisfied. Pause in_progress -> paused for unfinished blocked work; resume
paused -> in_progress when unblocked. Every real transition needs a non-empty
appendLog; same-status patches do not. Follow the task_update transition
contract.

Do not materially change an active task's execution contract without explicit
user approval.

When multiple task state changes are known together, apply them in one atomic
task_update call.

Use the latest successful task_create, task_update, task_get, or task_list
response as current state. Call task_get only when state is unknown, may have
changed, or full dependency or log details are needed.

## Rework

When a separate acceptance task requests rework, do not create an additional
task.

In one atomic task_update call, pause the reviewer (in_progress -> paused) and
reopen the writer (completed -> in_progress) with an actionable appendLog
describing the correction on each transition.

Complete the writer again after the correction passes its checks, then resume
the reviewer with paused -> in_progress. Resume the reviewer only after the
writer has completed again.

## Blocking

When execution cannot safely continue, stop dependent work and
leave unrelated independent work unaffected.

Use the terminal deleted status only when a task is intentionally removed from
scope; NEVER use it to conceal unfinished or unsuccessful work.

${TASK_MANAGEMENT_TAG_END}`;

  pi.on("session_start", async (_event, ctx) => {
    await refreshWidgetForSession(ctx, refreshWidget);
  });

  pi.on("turn_start", async (_event, ctx) => {
    await refreshWidgetForSession(ctx, refreshWidget, true);
  });

  // System-prompt chaining (distinct from tool promptSnippet/summary
  // descriptions, which stay unchanged either way). The handler is registered
  // only when `injectGuidelines` is true; when false, nothing is appended.
  // Selected-tools gating and the duplicate-block guard match the original
  // 69135c4 behavior: inject only while task_create is active, and leave an
  // existing block unchanged (chained handlers from other extensions may
  // have already appended it).
  if (config.injectGuidelines) {
    pi.on("before_agent_start", (event) => {
      if (!event.systemPromptOptions.selectedTools?.includes("task_create"))
        return;
      if (event.systemPrompt.includes(TASK_MANAGEMENT_TAG_START)) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${taskManagementPrompt}`,
      };
    });
  }

  pi.registerCommand("tasks", {
    description: "View and clear session tasks.",
    handler: async (_args, ctx) => {
      const store = await TaskStore.load(
        taskFilePath(ctx.cwd, sessionIdOf(ctx)),
      );
      const [viewLabel, clearCompletedLabel, clearAllLabel] = tasksMenuLabels(
        store.list(),
      );
      const choice = await ctx.ui.select("Tasks", [
        viewLabel,
        clearCompletedLabel,
        clearAllLabel,
      ]);
      if (choice === undefined) return;
      if (choice === viewLabel) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            "Task viewer requires an interactive terminal session.",
            "warning",
          );
          return;
        }
        try {
          await ctx.ui.custom<void>(
            (tui, theme, keybindings, done) =>
              createTasksViewer(store.list(), {
                done: () => done(undefined as never),
                theme,
                tui,
                keybindings,
                config,
              }),
            { overlay: true, overlayOptions: { ...TASKS_OVERLAY_OPTIONS } },
          );
        } catch (error) {
          ctx.ui.notify(
            `Task viewer failed: ${error instanceof Error ? error.message : String(error)}.`,
            "error",
          );
        }
        return;
      }
      if (choice === clearCompletedLabel) {
        const completed = store.list("completed").length;
        if (completed === 0) {
          ctx.ui.notify("No completed tasks to clear.");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Clear completed tasks",
          `Delete ${completed} completed task(s)? This cannot be undone.`,
        );
        if (!confirmed) return;
        try {
          const removed = await store.clearCompleted();
          refreshWidget(ctx, store);
          ctx.ui.notify(`Cleared ${removed.length} completed task(s).`);
        } catch (error) {
          ctx.ui.notify(
            `Failed to clear completed tasks: ${error instanceof Error ? error.message : String(error)}.`,
            "error",
          );
        }
        return;
      }
      if (choice === clearAllLabel) {
        const total = store.list().length;
        if (total === 0) {
          ctx.ui.notify("No tasks to clear.");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Clear all tasks",
          `Delete all ${total} task(s)? This cannot be undone.`,
        );
        if (!confirmed) return;
        try {
          const removed = await store.clearAll();
          refreshWidget(ctx, store);
          ctx.ui.notify(`Cleared all ${removed} task(s).`);
        } catch (error) {
          ctx.ui.notify(
            `Failed to clear tasks: ${error instanceof Error ? error.message : String(error)}.`,
            "error",
          );
        }
      }
    },
  });

  pi.registerTool({
    name: "task_create",
    label: "Create tasks",
    description: `Use this tool to create pending tasks atomically for tracking work state in the current session.`,
    promptSnippet:
      "Track multi-step work with the task_create/task_update/task_get/task_list tools.",
    parameters: TaskCreateParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params: Static<typeof TaskCreateParams>,
      _signal,
      _onUpdate,
      ctx,
    ) {
      const filePath = taskFilePath(ctx.cwd, sessionIdOf(ctx));
      const store = await TaskStore.load(filePath);
      try {
        if ("maxAttempts" in (params as unknown as Record<string, unknown>)) {
          const text =
            "`maxAttempts` cannot be set per task; configure `maxAttempts` in pi-tasks.json.";
          return errorResult(
            text,
            taskRenderDetails(() =>
              renderTaskToolError("create", text, undefined, true),
            ),
          );
        }
        for (const task of params.tasks) {
          if (
            task !== null &&
            typeof task === "object" &&
            "maxAttempts" in task
          ) {
            const text =
              "`maxAttempts` cannot be set per task; configure `maxAttempts` in pi-tasks.json.";
            return errorResult(
              text,
              taskRenderDetails(() =>
                renderTaskToolError("create", text, undefined, true),
              ),
            );
          }
        }
        const created = await store.createMany(
          params.tasks.map((task) => ({
            ...task,
            metadata: task.metadata as Record<string, unknown> | undefined,
          })),
          config.maxAttempts,
        );
        refreshWidget(ctx, store);
        return textResult(
          JSON.stringify(created, null, 2),
          taskRenderDetails(() => renderTaskCreate(created.tasks)),
        );
      } catch (error) {
        return errorResult(
          error instanceof TaskError ? error.message : String(error),
          taskRenderDetails(() =>
            renderTaskToolError(
              "create",
              error,
              undefined,
              error instanceof TaskError,
            ),
          ),
        );
      }
    },
    renderCall(_args, theme, context) {
      return renderTaskCall("Creating tasks…", context, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskResult(
        result,
        options.expanded,
        context?.isError === true,
        "create",
        undefined,
        theme,
        context,
      );
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update tasks",
    description: `Use this tool to patch one or more tasks atomically as a declarative patch set. Patches apply to a cloned proposed state, not as a command sequence.
Lifecycle and dependency rules are evaluated from original state to the complete proposed final state.`,
    parameters: TaskUpdateParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params: Static<typeof TaskUpdateParams>,
      _signal,
      _onUpdate,
      ctx,
    ) {
      const store = await TaskStore.load(
        taskFilePath(ctx.cwd, sessionIdOf(ctx)),
      );
      try {
        const storeUpdates = params.updates.map((update) => ({
          ...update,
          metadata: update.metadata as Record<string, unknown> | undefined,
        }));
        const previousTasks = new Map(
          storeUpdates.map((update) => [update.id, store.get(update.id)]),
        );
        const previousStatuses = new Map(
          [...previousTasks].map(([id, task]) => [id, task?.status]),
        );
        const updated = await store.updateMany(storeUpdates);
        refreshWidget(ctx, store);
        for (const task of updated) {
          if (
            previousStatuses.get(task.id) !== "in_progress" &&
            task.status === "in_progress" &&
            task.maxAttempts > 0 &&
            task.attempt === task.maxAttempts
          ) {
            const warning = `Task #${task.id} is running its final attempt (${task.attempt}/${task.maxAttempts}). No retries remain after this run.`;
            try {
              pi.sendMessage(
                {
                  customType: "pi-tasks-final-attempt",
                  content: warning,
                  display: false,
                },
                { deliverAs: "steer", triggerTurn: false },
              );
            } catch {
              // Context injection failures must not fail a persisted update.
            }
            try {
              const notify = (ctx.ui as unknown as { notify?: unknown }).notify;
              if (typeof notify === "function") {
                (notify as (message: string, level: string) => unknown).call(
                  ctx.ui,
                  warning,
                  "warning",
                );
              }
            } catch {
              // Notification failures must not fail a persisted update.
            }
          }
        }
        return textResult(
          JSON.stringify({ updated }, null, 2),
          taskRenderDetails(() =>
            renderTaskUpdate(
              updated.flatMap((after) => {
                const before = previousTasks.get(after.id);
                return before ? [{ before, after }] : [];
              }),
              config,
              store.list(),
            ),
          ),
        );
      } catch (error) {
        return errorResult(
          error instanceof TaskError ? error.message : String(error),
          taskRenderDetails(() =>
            renderTaskToolError(
              "update",
              error,
              undefined,
              error instanceof TaskError,
            ),
          ),
        );
      }
    },
    renderCall(_args, theme, context) {
      return renderTaskCall("Updating tasks…", context, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskResult(
        result,
        options.expanded,
        context?.isError === true,
        "update",
        undefined,
        theme,
        context,
      );
    },
  });

  pi.registerTool({
    name: "task_get",
    label: "Get task",
    description: `Use this tool to return the full details of one task by numeric ID.

Details include dependencies, metadata, and the execution log.`,
    parameters: TaskGetParams,
    async execute(
      _toolCallId,
      params: Static<typeof TaskGetParams>,
      _signal,
      _onUpdate,
      _ctx,
    ) {
      if (!isValidId(params.id)) return invalidIdResult(params.id);
      const store = await TaskStore.load(
        taskFilePath(_ctx.cwd, sessionIdOf(_ctx)),
      );
      const task = store.get(params.id);
      if (!task) {
        const text = `Task #${params.id} does not exist.`;
        return errorResult(
          text,
          taskRenderDetails(() =>
            renderTaskToolError("get", text, params.id, true),
          ),
        );
      }
      return textResult(
        JSON.stringify(task, null, 2),
        taskRenderDetails(() => renderTaskGet(task, store.list(), config)),
      );
    },
    renderCall(_args, theme, context) {
      return renderTaskCall("Retrieving task…", context, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskResult(
        result,
        options.expanded,
        context?.isError === true,
        "get",
        context?.args?.id,
        theme,
        context,
      );
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List tasks",
    description: `Use this tool to list tasks in the current session's task list.
Pass a status filter for one lifecycle state, or omit it for the full list.
Use it for an overview of task state across the session.`,
    parameters: TaskListParams,
    async execute(
      _toolCallId,
      params: Static<typeof TaskListParams>,
      _signal,
      _onUpdate,
      ctx,
    ) {
      const status =
        params.status !== undefined && isTaskStatus(params.status)
          ? params.status
          : undefined;
      if (params.status !== undefined && status === undefined) {
        const text = `Invalid status: ${String(params.status)}.`;
        return errorResult(
          text,
          taskRenderDetails(() =>
            renderTaskToolError("list", text, undefined, true),
          ),
        );
      }
      const store = await TaskStore.load(
        taskFilePath(ctx.cwd, sessionIdOf(ctx)),
      );
      const allTasks = store.list();
      const tasks =
        status === undefined
          ? allTasks
          : allTasks.filter((task) => task.status === status);
      return textResult(
        JSON.stringify(tasks, null, 2),
        taskRenderDetails(() => renderTaskList(tasks, status, allTasks)),
      );
    },
    renderCall(_args, theme, context) {
      return renderTaskCall("Listing tasks…", context, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskResult(
        result,
        options.expanded,
        context?.isError === true,
        "list",
        undefined,
        theme,
        context,
      );
    },
  });
}
