import { Container, stripTerminalSequences, Text, truncateToWidth as truncateTerminalText, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type PiTasksConfig } from "./config.js";
import type { Task } from "./types.js";
import { statusGlyphFor } from "./widget.js";

const MAX_LINE_WIDTH = 120;
const PREVIEW_WIDTH = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

interface TaskTheme {
  fg(color: "success" | "toolTitle" | "toolOutput" | "error" | "dim" | "accent", text: string): string;
}

interface TaskRenderState {
  taskCallSpinner?: TaskCallSpinner;
}

export interface TaskRenderContext {
  toolCallId?: string;
  executionStarted?: boolean;
  isPartial?: boolean;
  invalidate?: () => void;
  lastComponent?: unknown;
  state?: TaskRenderState;
}

interface ActiveTaskCallSpinner {
  spinner: TaskCallSpinner;
  states: Set<TaskRenderState>;
}

const activeTaskCallSpinners = new Map<string, ActiveTaskCallSpinner>();

function formatPendingSpinner(frame: string, label: string, theme?: TaskTheme): string {
  if (!theme || typeof theme.fg !== "function") return `${frame} ${label}`;
  try {
    return `${theme.fg("accent", frame)} ${theme.fg("toolTitle", label)}`;
  } catch {
    return `${frame} ${label}`;
  }
}

function formatPendingLabel(label: string, theme?: TaskTheme): string {
  if (!theme || typeof theme.fg !== "function") return label;
  try {
    return theme.fg("toolTitle", label);
  } catch {
    return label;
  }
}

export class TaskCallSpinner extends Text {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private label = "";
  private theme?: TaskTheme;
  private requestRender: () => void = () => {};
  private onInvalidateFailure: () => void = () => {};

  constructor() {
    super("", 0, 0);
  }

  update(
    label: string,
    requestRender: (() => void) | undefined,
    animate: boolean,
    onInvalidateFailure?: () => void,
    theme?: TaskTheme,
  ): void {
    this.label = label;
    this.theme = theme;
    this.requestRender = requestRender ?? (() => {});
    this.onInvalidateFailure = onInvalidateFailure ?? (() => {});
    if (animate) {
      this.setText(formatPendingSpinner(SPINNER_FRAMES[this.frame], label, this.theme));
      if (this.timer === undefined) {
        this.timer = setInterval(() => {
          this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
          this.setText(formatPendingSpinner(SPINNER_FRAMES[this.frame], this.label, this.theme));
          try {
            this.requestRender();
          } catch {
            this.stop();
            this.onInvalidateFailure();
          }
        }, SPINNER_INTERVAL_MS);
        this.timer.unref?.();
      }
    } else {
      this.stop();
      this.setText(label);
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export interface CollapsedExpanded {
  collapsed: string;
  expanded: string;
}

export type TaskToolOperation = "create" | "update" | "get" | "list";

export interface TaskToolRenderDetails {
  rendering: CollapsedExpanded;
}

export function sanitizeText(value: unknown): string {
  return stripTerminalSequences(String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateToWidth(value: unknown, width = MAX_LINE_WIDTH): string {
  return truncateTerminalText(sanitizeText(value), width, "…");
}

export function boundedPreview(value: unknown): string {
  return truncateToWidth(value, PREVIEW_WIDTH);
}

export function pluralizeTask(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

function expanded(summary: string, lines: string[]): CollapsedExpanded {
  return {
    collapsed: summary,
    expanded: lines.length === 0 ? summary : `${summary}\n${lines.map((line) => `  ${truncateToWidth(line, MAX_LINE_WIDTH - 2)}`).join("\n")}`,
  };
}

export function renderTaskCreate(
  tasks: Pick<Task, "id" | "subject">[],
  config: PiTasksConfig = DEFAULT_CONFIG,
): CollapsedExpanded {
  const summary = `✓ Created ${pluralizeTask(tasks.length)}`;
  return expanded(summary, tasks.map((task) => `${config.glyphs.pending.character} #${task.id} ${truncateToWidth(task.subject, MAX_LINE_WIDTH - 12)}`));
}

const DIFF_FIELDS = ["status", "subject", "description", "assignee", "dependencies", "reviews", "metadata", "log"] as const;
export type TaskDiffField = (typeof DIFF_FIELDS)[number];

function semanticValue(task: Task, field: TaskDiffField): unknown {
  if (field === "dependencies") return task.blockedBy;
  if (field === "reviews") return task.reviewOf;
  return task[field];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function semanticallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function semanticDiff(before: Task, after: Task): TaskDiffField[] {
  return DIFF_FIELDS.filter((field) => !semanticallyEqual(semanticValue(before, field), semanticValue(after, field)));
}

export interface TaskUpdateRendering {
  before: Task;
  after: Task;
}

export function renderTaskUpdate(
  updates: TaskUpdateRendering[],
  config: PiTasksConfig = DEFAULT_CONFIG,
  tasks: readonly Task[] = updates.map(({ after }) => after),
): CollapsedExpanded {
  const summary = `✓ Updated ${pluralizeTask(updates.length)}`;
  const lines = updates.map(({ before, after }) => {
    const changes = semanticDiff(before, after).filter((field) => config.enableAssignee || field !== "assignee");
    const suffix = changes.length === 0 ? "no changes" : changes.join(", ");
    const glyph = statusGlyphFor(after, tasks, config);
    const fixedWidth = visibleWidth(`${glyph} #${after.id}  → ${suffix}`);
    const subjectWidth = Math.max(10, MAX_LINE_WIDTH - 2 - fixedWidth);
    return `${glyph} #${after.id} ${truncateToWidth(after.subject, subjectWidth)} → ${suffix}`;
  });
  return expanded(summary, lines);
}

export function renderTaskGet(
  task: Task,
  tasks: readonly Task[] = [task],
  config: PiTasksConfig = DEFAULT_CONFIG,
): CollapsedExpanded {
  const summary = `✓ Retrieved task #${task.id}`;
  const dependencies = task.blockedBy.length === 0 ? "—" : task.blockedBy.map((id) => `#${id}`).join(", ");
  const attempts = `${task.attempt}/${task.maxAttempts === 0 ? "unlimited" : task.maxAttempts}`;
  const lines = [
    `${statusGlyphFor(task, tasks, config)} #${task.id} ${boundedPreview(task.subject)}`,
    `Status: ${task.status}`,
  ];
  if (task.description) lines.push(`Description: ${boundedPreview(task.description)}`);
  if (config.enableAssignee) lines.push(`Assignee: ${task.assignee ? boundedPreview(task.assignee) : "—"}`);
  lines.push(`Dependencies: ${dependencies}`);
  if (task.reviewOf.length > 0) lines.push(`Review of: ${task.reviewOf.map((id) => `#${id}`).join(", ")}`);
  lines.push(`Attempts: ${attempts}`);
  const recent = task.log.slice(-3);
  if (recent.length === 0) {
    lines.push("Recent log: —");
  } else {
    lines.push("Recent log:", ...recent.map((entry) => `- ${boundedPreview(entry.message)}`));
  }
  return expanded(summary, lines);
}

export function renderTaskList(
  tasks: Task[],
  status?: string,
  config: PiTasksConfig = DEFAULT_CONFIG,
  allTasks: readonly Task[] = tasks,
): CollapsedExpanded {
  const filter = status === undefined ? "" : ` · status: ${truncateToWidth(status, 40)}`;
  if (tasks.length === 0) return { collapsed: `○ No tasks${filter}`, expanded: `○ No tasks${filter}` };
  const summary = `✓ Listed ${pluralizeTask(tasks.length)}${filter}`;
  return expanded(summary, tasks.map((task) => `${statusGlyphFor(task, allTasks, config)} #${task.id} ${truncateToWidth(task.subject, 68)} → ${task.status}`));
}

export function renderTaskToolError(
  operation: TaskToolOperation,
  error: unknown,
  id?: unknown,
  expected = false,
): CollapsedExpanded {
  const safeId = id === undefined ? "" : truncateToWidth(id, 30);
  const summary = operation === "create"
    ? "✗ Failed to create tasks"
    : operation === "update"
      ? "✗ Failed to update tasks"
      : operation === "get"
        ? `✗ Failed to retrieve task #${safeId}`
        : "✗ Failed to list tasks";
  const detail = expected ? truncateToWidth(error instanceof Error ? error.message : error) : "Unexpected internal error.";
  return expanded(summary, [detail]);
}

export function taskRenderDetails(factory: () => CollapsedExpanded): TaskToolRenderDetails | undefined {
  try {
    return { rendering: factory() };
  } catch {
    return undefined;
  }
}

function stopTaskCallSpinners(context?: TaskRenderContext): TaskCallSpinner | undefined {
  if (!context) return undefined;
  const toolCallId = typeof context.toolCallId === "string" && context.toolCallId.length > 0
    ? context.toolCallId
    : undefined;
  const entry = toolCallId === undefined ? undefined : activeTaskCallSpinners.get(toolCallId);
  const registered = entry?.spinner;
  const last = context.lastComponent instanceof TaskCallSpinner ? context.lastComponent : undefined;
  const stored = context.state?.taskCallSpinner;
  const spinners = new Set([registered, last, stored]);
  for (const spinner of spinners) spinner?.stop();
  for (const [id, active] of activeTaskCallSpinners) {
    if (!spinners.has(active.spinner)) continue;
    activeTaskCallSpinners.delete(id);
    for (const state of active.states) {
      if (spinners.has(state.taskCallSpinner)) delete state.taskCallSpinner;
    }
  }
  if (context.state) delete context.state.taskCallSpinner;
  return last ?? stored ?? registered;
}

export function renderTaskCall(text: string, context?: TaskRenderContext, theme?: TaskTheme): Text | Container {
  // Truncate the plain label first; themed ANSI wrappers add no visible width
  // and Text wraps ANSI-aware, so themed output stays within host width.
  const label = truncateToWidth(text);
  if (!context) return new Text(formatPendingLabel(label, theme), 0, 0);

  if (context.isPartial === false) {
    stopTaskCallSpinners(context);
    // The host composes renderCall above renderResult, so settled calls must occupy no rows.
    return new Container();
  }
  if (context.isPartial !== true) {
    stopTaskCallSpinners(context);
    return new Text(formatPendingLabel(label, theme), 0, 0);
  }

  const toolCallId = typeof context.toolCallId === "string" && context.toolCallId.length > 0
    ? context.toolCallId
    : undefined;
  const entry = toolCallId === undefined ? undefined : activeTaskCallSpinners.get(toolCallId);
  const registered = entry?.spinner;
  const last = context.lastComponent instanceof TaskCallSpinner ? context.lastComponent : undefined;
  const stored = context.state?.taskCallSpinner;
  const existing = last ?? stored ?? registered;
  if (context.executionStarted === true && existing === undefined) {
    // Replay/export starts here without the host's pre-execution render; do not persist a loading row.
    return new Container();
  }
  if (toolCallId === undefined) {
    if (context.executionStarted === true && existing) {
      existing.update(label, context.invalidate, true, () => {
        if (context.state?.taskCallSpinner === existing) delete context.state.taskCallSpinner;
      }, theme);
      return existing;
    }
    stopTaskCallSpinners(context);
    return new Text(formatPendingLabel(label, theme), 0, 0);
  }

  const lastWasReplaced = context.lastComponent !== undefined && last === undefined;
  const spinner = context.executionStarted !== true && lastWasReplaced
    ? new TaskCallSpinner()
    : existing ?? new TaskCallSpinner();
  for (const stale of new Set([registered, last, stored])) {
    if (stale && stale !== spinner) stale.stop();
  }
  if (registered && registered !== spinner) {
    for (const state of entry.states) {
      if (state.taskCallSpinner === registered) delete state.taskCallSpinner;
    }
  }
  const states = registered === spinner && entry ? entry.states : new Set<TaskRenderState>();
  if (context.state) {
    context.state.taskCallSpinner = spinner;
    states.add(context.state);
  }
  activeTaskCallSpinners.set(toolCallId, { spinner, states });
  spinner.update(label, context.invalidate, true, () => {
    const current = activeTaskCallSpinners.get(toolCallId);
    if (current?.spinner !== spinner) return;
    activeTaskCallSpinners.delete(toolCallId);
    for (const state of current.states) {
      if (state.taskCallSpinner === spinner) delete state.taskCallSpinner;
    }
  }, theme);
  return spinner;
}

function themedRendering(rendering: CollapsedExpanded, expandedResult: boolean, theme: TaskTheme): string {
  const plain = expandedResult ? rendering.expanded : rendering.collapsed;
  const [summary, ...details] = plain.split("\n");
  const glyph = summary.slice(0, 1);
  const summaryText = summary.slice(2);
  const color = glyph === "✓" ? "success" : glyph === "✗" ? "error" : glyph === "○" ? "dim" : undefined;
  if (!color) return plain;

  const themedSummary = glyph === "✗"
    ? `${theme.fg("error", glyph)} ${theme.fg("error", summaryText)}`
    : `${theme.fg(color, glyph)} ${theme.fg("toolTitle", summaryText)}`;
  return details.length === 0
    ? themedSummary
    : `${themedSummary}\n${details.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
}

export function renderTaskResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  expandedResult: boolean,
  isError: boolean,
  operation?: TaskToolOperation,
  id?: unknown,
  theme?: TaskTheme,
  context?: TaskRenderContext,
): Text {
  if (context?.isPartial !== true) stopTaskCallSpinners(context);
  try {
    const details = result.details as TaskToolRenderDetails | undefined;
    const candidate = details?.rendering;
    const rendering = candidate && typeof candidate.collapsed === "string" && typeof candidate.expanded === "string"
      ? candidate
      : isError && operation
        ? renderTaskToolError(operation, undefined, id)
        : undefined;
    if (rendering) {
      const plain = expandedResult ? rendering.expanded : rendering.collapsed;
      if (!theme || typeof theme.fg !== "function") return new Text(plain, 0, 0);
      try {
        return new Text(themedRendering(rendering, expandedResult, theme), 0, 0);
      } catch {
        return new Text(plain, 0, 0);
      }
    }
  } catch {
    // Fall through to the host-compatible plain result.
  }
  const content = result.content[0];
  return new Text(content?.type === "text" ? content.text ?? "" : "", 0, 0);
}
