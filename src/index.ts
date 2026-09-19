/**
 * pi-tasks — per-main-session task tracking for Pi.
 *
 * Tools (exactly these five; no convenience, dependency, or subagent tools):
 *   TaskCreate, TaskUpdate, TaskGet, TaskList, TaskDelete
 *
 * The tools are registered by the host/main Pi extension context only. This
 * extension implements no shared or subagent stores: every store is a
 * per-main-session file under `<cwd>/.pi/tasks/`, and subagents must not use
 * these tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { TaskError, TaskStore, taskFilePath, turnStartStore } from "./store.js";
import { createTasksViewer } from "./tasks-ui.js";
import { isTaskStatus, type Task } from "./types.js";
import { createTaskWidget, type ThemeLike, type TuiWidthLike } from "./widget.js";

const WIDGET_KEY = "tasks";

const TaskId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Numeric task ID." });
const BlockedBy = Type.Array(TaskId, { description: "Task IDs this task depends on." });
const Metadata = Type.Record(Type.String(), Type.Unknown(), { description: "Free-form metadata object." });
const Status = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]);

const TaskCreateParams = Type.Object({
  subject: Type.String({ description: "Short task title." }),
  description: Type.String({ description: "Longer task detail." }),
  assignee: Type.Optional(Type.String({ description: "Assigned agent type shown as [assignee]." })),
  color: Type.Optional(Type.String({ description: "Accent color name for the status glyph. Do not set unless the user explicitly requests a color." })),
  blockedBy: Type.Optional(BlockedBy),
  metadata: Type.Optional(Metadata),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Per-task attempt cap. Defaults to 9." })),
});

const TaskUpdateParams = Type.Object({
  id: TaskId,
  subject: Type.Optional(Type.String({ description: "New title." })),
  description: Type.Optional(Type.String({ description: "New detail text. Do not use for progress, rework, validation, blocker, or handoff notes; use appendLog instead." })),
  assignee: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Assigned agent type shown as [assignee], or null to remove it." })),
  color: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "New status glyph color, or null to remove it. Do not set or change it unless the user explicitly requests a color." })),
  status: Type.Optional(Status),
  blockedBy: Type.Optional(BlockedBy),
  metadata: Type.Optional(Metadata),
  appendLog: Type.Optional(Type.String({ minLength: 1, description: "Reason for the status change." })),
});

const TaskGetParams = Type.Object({
  id: TaskId,
});

const TaskListParams = Type.Object({
  status: Type.Optional(Status),
});

const TaskDeleteParams = Type.Object({
  id: TaskId,
});

type ErrorResult = {
  content: [{ type: "text"; text: string }];
  details: undefined;
  isError: true;
};

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined as never };
}

function errorResult(text: string): ErrorResult {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true as const };
}

function invalidIdResult(id: unknown): ErrorResult {
  return errorResult(`Invalid task id: ${String(id)}. Expected a positive safe integer.`);
}

const PREFIX_RENAMED_MESSAGE = "`prefix` was renamed to `assignee`; use `assignee`.";

function hasPrefixParam(params: Record<string, unknown>): boolean {
  return "prefix" in params;
}

function isValidId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

/** Minimal UI surface used for the persistent task widget. */
interface WidgetUI {
  setWidget(key: string, content: unknown, options?: unknown): void;
}

function refreshWidget(ctx: ExtensionContext, store: TaskStore): void {
  try {
    const ui = ctx.ui as unknown as WidgetUI;
    if (!ui || typeof ui.setWidget !== "function") return;
    const tasks = store.list();
    if (tasks.length === 0) {
      ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const snapshot = tasks;
    const timing = store.activeTiming();
    ui.setWidget(
      WIDGET_KEY,
      (tui: unknown, theme: ThemeLike) => createTaskWidget(snapshot, tui as TuiWidthLike, theme, undefined, timing),
      { placement: "aboveEditor" },
    );
  } catch {
    // Widget updates must never break tool execution or turn handling.
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
  return [`View all tasks (${tasks.length})`, `Clear completed (${completed})`, `Clear all (${tasks.length})`];
}

export default function (pi: ExtensionAPI) {
  pi.on("turn_start", async (_event, ctx) => {
    const { store } = await turnStartStore(ctx.cwd, sessionIdOf(ctx));
    refreshWidget(ctx, store);
  });

  pi.registerCommand("tasks", {
    description: "View and clear session tasks.",
    handler: async (_args, ctx) => {
      const store = await TaskStore.load(taskFilePath(ctx.cwd, sessionIdOf(ctx)));
      const [viewLabel, clearCompletedLabel, clearAllLabel] = tasksMenuLabels(store.list());
      const choice = await ctx.ui.select("Tasks", [viewLabel, clearCompletedLabel, clearAllLabel]);
      if (choice === undefined) return;
      if (choice === viewLabel) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Task viewer requires an interactive terminal session.", "warning");
          return;
        }
        try {
          await ctx.ui.custom<void>(
            (tui, theme, keybindings, done) =>
              createTasksViewer(store.list(), { done: () => done(undefined as never), theme, tui, keybindings }),
            { overlay: true, overlayOptions: { ...TASKS_OVERLAY_OPTIONS } },
          );
        } catch (error) {
          ctx.ui.notify(`Task viewer failed: ${error instanceof Error ? error.message : String(error)}.`, "error");
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
    name: "TaskCreate",
    label: "Create task",
    description: "Create a task in the current session's task list. Dependencies in blockedBy must already exist.",
    promptSnippet: "Track multi-step work with the TaskCreate/TaskUpdate/TaskGet/TaskList/TaskDelete tools.",
    parameters: TaskCreateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof TaskCreateParams>, _signal, _onUpdate, ctx) {
      if (hasPrefixParam(params as unknown as Record<string, unknown>)) {
        return errorResult(PREFIX_RENAMED_MESSAGE);
      }
      const filePath = taskFilePath(ctx.cwd, sessionIdOf(ctx));
      const store = await TaskStore.load(filePath);
      try {
        const task = await store.create({
          subject: params.subject,
          description: params.description,
          assignee: params.assignee,
          color: params.color,
          blockedBy: params.blockedBy,
          metadata: params.metadata as Record<string, unknown> | undefined,
          maxAttempts: params.maxAttempts,
        });
        refreshWidget(ctx, store);
        return textResult(JSON.stringify(task, null, 2));
      } catch (error) {
        return errorResult(error instanceof TaskError ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "Update task",
    description:
      "Patch a task by numeric ID. metadata shallow-merges; appendLog appends a timestamped execution note and should be used instead of rewriting description for rework, validation, blockers, or handoffs. assignee/color accept null to remove. Entering in_progress requires completed dependencies.",
    parameters: TaskUpdateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof TaskUpdateParams>, _signal, _onUpdate, ctx) {
      if (!isValidId(params.id)) return invalidIdResult(params.id);
      if ("attempt" in (params as Record<string, unknown>)) {
        return errorResult("attempt cannot be updated; it increments only on entry into in_progress.");
      }
      if ("maxAttempts" in (params as Record<string, unknown>)) {
        return errorResult("maxAttempts cannot be updated; it is set once at creation.");
      }
      if (hasPrefixParam(params as unknown as Record<string, unknown>)) {
        return errorResult(PREFIX_RENAMED_MESSAGE);
      }
      const store = await TaskStore.load(taskFilePath(ctx.cwd, sessionIdOf(ctx)));
      try {
        const status = params.status !== undefined && isTaskStatus(params.status) ? params.status : undefined;
        if (params.status !== undefined && status === undefined) {
          return errorResult(`Invalid status: ${String(params.status)}.`);
        }
        const previousStatus = store.get(params.id)?.status;
        const updated = await store.update(params.id, {
          subject: params.subject,
          description: params.description,
          assignee: params.assignee,
          color: params.color,
          status,
          blockedBy: params.blockedBy,
          metadata: params.metadata as Record<string, unknown> | undefined,
          appendLog: params.appendLog,
        });
        refreshWidget(ctx, store);
        if (previousStatus !== "in_progress" && updated.status === "in_progress" && updated.attempt === updated.maxAttempts) {
          const warning = `Task #${updated.id} is running its final attempt (${updated.attempt}/${updated.maxAttempts}). No retries remain after this run.`;
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
              (notify as (message: string, level: string) => unknown).call(ctx.ui, warning, "warning");
            }
          } catch {
            // Notification failures must not fail a persisted update.
          }
        }
        return textResult(JSON.stringify(params, null, 2));
      } catch (error) {
        return errorResult(error instanceof TaskError ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "TaskGet",
    label: "Get task",
    description: "Return the full details of one task by numeric ID.",
    parameters: TaskGetParams,
    async execute(_toolCallId, params: Static<typeof TaskGetParams>, _signal, _onUpdate, _ctx) {
      if (!isValidId(params.id)) return invalidIdResult(params.id);
      const store = await TaskStore.load(taskFilePath(_ctx.cwd, sessionIdOf(_ctx)));
      const task = store.get(params.id);
      if (!task) return errorResult(`Task #${params.id} does not exist.`);
      return textResult(JSON.stringify(task, null, 2));
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "List tasks",
    description: "List tasks in the current session's task list, optionally filtered by status.",
    parameters: TaskListParams,
    async execute(_toolCallId, params: Static<typeof TaskListParams>, _signal, _onUpdate, ctx) {
      const status = params.status !== undefined && isTaskStatus(params.status) ? params.status : undefined;
      if (params.status !== undefined && status === undefined) {
        return errorResult(`Invalid status: ${String(params.status)}.`);
      }
      const store = await TaskStore.load(taskFilePath(ctx.cwd, sessionIdOf(ctx)));
      return textResult(JSON.stringify(store.list(status), null, 2));
    },
  });

  pi.registerTool({
    name: "TaskDelete",
    label: "Delete task",
    description: "Delete a task by numeric ID. Refused while other tasks depend on it.",
    parameters: TaskDeleteParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof TaskDeleteParams>, _signal, _onUpdate, ctx) {
      if (!isValidId(params.id)) return invalidIdResult(params.id);
      const store = await TaskStore.load(taskFilePath(ctx.cwd, sessionIdOf(ctx)));
      try {
        await store.delete(params.id);
        refreshWidget(ctx, store);
        return textResult(JSON.stringify(params, null, 2));
      } catch (error) {
        return errorResult(error instanceof TaskError ? error.message : String(error));
      }
    },
  });
}
