/**
 * Presentational task rendering. Pure functions over task state: this module
 * never reads or writes the store and never changes lifecycle/model semantics.
 *
 * Each line shows the numeric ID with its remaining-attempts indicator
 * (`↻N`, omitted for unlimited tasks), the optional `@assignee` (only when
 * `enableAssignee` is true), and the subject. Shorter
 * `#<id>` labels are right-padded to the widest ID in the rendered set so the
 * `↻N` column starts at a consistent position. Shorter `↻N` and `@assignee`
 * labels are right-padded to the widest corresponding label in the set so the
 * following columns start consistently; tasks without an assignee reserve the
 * assignee width only when at least one displayed task has an assignee, and unlimited tasks
 * reserve the remaining-attempts width only when at least one finite task is present. `in_progress` lines append the
 * running per-attempt duration measured from `startedAt` to the supplied
 * current time (`Date.now()` by default; pass an explicit `nowMs` for
 * deterministic rendering/tests), showing `0s` immediately at zero. `completed`
 * lines append only the frozen `<duration>` for the last finished attempt
 * (`tookMs`, or the `createdAt` to `updatedAt` span for legacy tasks).
 * `pending` lines show no duration: a new attempt shows `0s` on entry into
 * `in_progress`. `paused` and `deleted` lines append the frozen attempt
 * duration like `completed` lines and never blink; deleted plain rows append
 * `[deleted]`.
 * The header always shows `● Tasks · N total · M done` (including `0 done`), plus
 * nonzero ` · P paused` and ` · D deleted` segments.
 * It appends the global accumulated active (wall-clock union)
 * time only after a task has entered `in_progress`; the themed header renders
 * the accent title (`●` plus bold `Tasks`) followed by a single dim stats tail
 * (` · N total · M done`, plus status counts and ` · <duration>` when present).
 * Status and review state select the configured glyph; in-progress tasks use
 * configured animation frames. Glyph colors are fixed and derived from status (plus the attempt count for
 * pending): fresh pending (`attempt` 0) renders dim/gray, retried pending
 * (`attempt` > 0) renders yellow/warning, `in_progress` and `completed` render
 * green/success, `paused` renders yellow/warning, and `deleted` renders dim/gray.
 * Subject and assignee styling is fixed as well: pending and paused use the
 * default text color, `in_progress` uses default text color bold, `completed`
 * uses dim styling without strikethrough, and `deleted` uses dim strikethrough.
 * The optional `@assignee` always uses the same color, weight, and
 * decoration as the subject. Elapsed/finished duration text renders dim/gray
 * in themed lines and is appended plain after the subject in the text fallback.
 * In-progress glyphs animate every 250 ms; legacy custom characters retain a same-width blink.
 *
 * Migration: tasks and configs written before per-task/configurable colors
 * were removed may still contain a task `color` or a glyph `defaultColor`.
 * Persisted `color` fields are ignored on load and omitted on write; config
 * `defaultColor` values are ignored (reported as unknown keys); legacy
 * `character` values and the new review/frame fields are honored.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type PiTasksConfig } from "./config.js";
import { effectivePrereqs, reviewerFor } from "./store.js";
import type { Task } from "./types.js";

export type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

function inProgressFrames(config: PiTasksConfig): string[] {
  return config.glyphs.inProgress.frames;
}

/** Resolve the presentation glyph with review state and animation context. */
export function statusGlyphFor(
  task: Task,
  tasks: readonly Task[] = [task],
  config: PiTasksConfig = DEFAULT_CONFIG,
  frame = 0,
): string {
  if (task.status === "in_progress") {
    const frames = inProgressFrames(config);
    return frames[((frame % frames.length) + frames.length) % frames.length];
  }
  if (task.status === "completed") {
    const reviewer = reviewerFor(tasks, task.id);
    return reviewer !== undefined && reviewer.status !== "completed"
      ? config.glyphs.completed.awaitingReviewCharacter
      : config.glyphs.completed.character;
  }
  if (task.status === "paused") return config.glyphs.paused.character;
  if (task.status === "deleted") return config.glyphs.deleted.character;
  return task.attempt > 0 ? config.glyphs.pending.retriedCharacter : config.glyphs.pending.character;
}

/** Static glyph character for a task. In-progress tasks use their first frame. */
export function statusGlyph(task: Task, config: PiTasksConfig = DEFAULT_CONFIG): string {
  return statusGlyphFor(task, [task], config);
}

/** Blank matching the glyph's visible width for legacy custom in-progress blink. */
export function blankGlyph(task: Task, config: PiTasksConfig = DEFAULT_CONFIG): string {
  return " ".repeat(Math.max(1, visibleWidth(statusGlyph(task, config))));
}

/**
 * The remaining-attempts indicator for the persistent widget: ` ↻N` for finite
 * tasks, or an empty string for unlimited tasks (`maxAttempts` 0). `N` is the
 * remaining total attempts, counting the first attempt as an attempt:
 * `max(0, maxAttempts - attempt)`, so `attempt` 0 shows `maxAttempts`,
 * `attempt` 1 shows `maxAttempts - 1`, and an exhausted task shows `↻0`.
 * The `/tasks` list/detail UI and JSON tool payloads keep the numeric
 * `(<attempt>/<maxAttempts>)` counter via {@link attemptCounter}.
 */
export function remainingRetries(task: Task): string {
  if (task.maxAttempts === 0) return "";
  return ` ↻${Math.max(0, task.maxAttempts - task.attempt)}`;
}

/**
 * The numeric `(<attempt>/<maxAttempts>)` counter, or an empty string for unlimited
 * tasks (`maxAttempts` 0). Used by the `/tasks` list/detail UI; JSON tool
 * payloads always keep both fields. The persistent widget renders
 * {@link remainingRetries} instead.
 */
export function attemptCounter(task: Task): string {
  return task.maxAttempts === 0 ? "" : ` (${task.attempt}/${task.maxAttempts})`;
}

function formatSecDuration(diffSec: number): string {
  if (!Number.isFinite(diffSec) || diffSec < 0) diffSec = 0;
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * Format a nonzero day/hour/minute/second elapsed duration from `createdAt`
 * to `nowMs` (defaults to `Date.now()`), in order (e.g. `1d 1h 1m 1s`).
 * Components whose value is zero are omitted; a sub-second (or future)
 * duration yields an empty string. Kept for task-age compatibility; the
 * widget itself measures attempts from `startedAt` and frozen `tookMs`.
 */
export function formatElapsedDuration(createdAt: string, nowMs: number = Date.now()): string {
  const createdMs = Date.parse(createdAt);
  return formatSecDuration(Math.floor((nowMs - createdMs) / 1000));
}

/** Format a millisecond duration the same way; sub-second (or negative) yields an empty string. */
export function formatMillisDuration(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  return formatSecDuration(Math.floor(ms / 1000));
}

/** Wall-clock union timing supplied by the store for the widget header. */
export interface ActiveTiming {
  totalActiveMs?: number;
  activeSince?: string;
}

function attemptElapsedMs(task: Task, nowMs: number): number {
  const startMs = Date.parse(task.startedAt ?? task.createdAt);
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, nowMs - startMs);
}

function tookDisplay(task: Task): string {
  if (task.tookMs !== undefined) return formatMillisDuration(task.tookMs) || "0s";
  // Legacy completed task without a frozen duration: freeze the
  // pre-upgrade age span so reloads neither reset it nor let it grow.
  const endMs = Date.parse(task.updatedAt);
  const startMs = Date.parse(task.createdAt);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return "0s";
  return formatSecDuration(Math.floor(Math.max(0, endMs - startMs) / 1000)) || "0s";
}

function durationSuffix(task: Task, nowMs: number): string {
  if (task.status === "in_progress") {
    const elapsed = formatMillisDuration(attemptElapsedMs(task, nowMs)) || "0s";
    return ` ${elapsed}`;
  }
  if (task.status === "completed" || task.status === "paused" || task.status === "deleted") {
    return ` ${tookDisplay(task)}`;
  }
  return "";
}

/** Pending-only effective-prerequisite suffix appended after the subject. */
export function blockedBySuffix(task: Task): string {
  const prerequisites = effectivePrereqs(task);
  return (task.status === "pending" || task.status === "paused") && prerequisites.length > 0
    ? ` → (${prerequisites.join(", ")})`
    : "";
}

/** Resolve the header total: finished union time plus the running slice (if any). Zero renders as `0s`. */
export function formatActiveTotal(timing: ActiveTiming | undefined, tasks: Task[], nowMs: number): string {
  const base = timing?.totalActiveMs ?? 0;
  let bonus = 0;
  if (timing?.activeSince !== undefined) {
    const startMs = Date.parse(timing.activeSince);
    if (Number.isFinite(startMs)) bonus = Math.max(0, nowMs - startMs);
  } else {
    // Direct rendering without store timing (e.g. legacy tests): derive the
    // running slice from the earliest active attempt so the header still ticks.
    let earliest: number | undefined;
    for (const task of tasks) {
      if (task.status !== "in_progress") continue;
      const startMs = Date.parse(task.startedAt ?? task.createdAt);
      if (Number.isFinite(startMs)) earliest = earliest === undefined ? startMs : Math.min(earliest, startMs);
    }
    if (earliest !== undefined) bonus = Math.max(0, nowMs - earliest);
  }
  return formatMillisDuration(base + bonus) || "0s";
}

/** Visible width of the widest `#<id>` label in the set, so shorter IDs can be padded right and the `↻N` column starts at a consistent position. */
export function idColumnWidth(tasks: Task[]): number {
  let width = 0;
  for (const task of tasks) width = Math.max(width, `#${task.id}`.length);
  return width;
}

/** Visible width of the widest `↻N` remaining-attempts label in the set (without the leading separator), so shorter remaining-attempts labels can be padded right and following content aligns. Unlimited tasks contribute no width; returns 0 when no finite task is present. */
export function retryColumnWidth(tasks: Task[]): number {
  let width = 0;
  for (const task of tasks) {
    const label = remainingRetries(task).trim();
    if (label !== "") width = Math.max(width, label.length);
  }
  return width;
}

/** Visible width of the widest `@assignee` label in the set (without its leading separator). Returns 0 when assignee display is disabled (`enableAssignee` false) or when no task has an assignee. */
export function assigneeColumnWidth(tasks: Task[], config: PiTasksConfig = DEFAULT_CONFIG): number {
  if (!config.enableAssignee) return 0;
  let width = 0;
  for (const task of tasks) {
    if (task.assignee !== undefined) width = Math.max(width, visibleWidth(`@${task.assignee}`));
  }
  return width;
}

function assigneeField(task: Task, width?: number): string {
  const label = task.assignee === undefined ? "" : `@${task.assignee}`;
  const fieldWidth = Math.max(visibleWidth(label), typeof width === "number" && width > 0 ? width : 0);
  if (fieldWidth === 0) return "";
  return `${label}${" ".repeat(Math.max(0, fieldWidth - visibleWidth(label)))}`;
}

/** Plain-text line: `#<id> ↻N @assignee subject`, a pending-only ` → (<blockedBy>)` suffix, and status-specific duration. No colors. The `↻N` indicator is omitted for unlimited tasks (`maxAttempts` 0). Pass collection widths to right-pad shorter ID, remaining-attempts, or assignee labels; all are omitted by default to preserve standalone output. Positive remaining-attempts and assignee widths reserve their columns for tasks without those labels. */
export function formatTaskLine(task: Task, nowMs: number = Date.now(), config: PiTasksConfig = DEFAULT_CONFIG, idWidth?: number, retryWidth?: number, assigneeWidth?: number, tasks: readonly Task[] = [task]): string {
  const idLabel = typeof idWidth === "number" && idWidth > 0 ? `#${task.id}`.padEnd(idWidth) : `#${task.id}`;
  let retryPart = remainingRetries(task);
  if (typeof retryWidth === "number" && retryWidth > 0) {
    const label = retryPart.trim();
    retryPart = label === "" ? ` ${" ".repeat(retryWidth)}` : ` ${label.padEnd(retryWidth)}`;
  }
  const assignee = !config.enableAssignee ? "" : assigneeField(task, assigneeWidth);
  const assigneePart = assignee === "" ? "" : ` ${assignee}`;
  const subject = task.status === "deleted" ? `${task.subject} [deleted]` : task.subject;
  return `  ${statusGlyphFor(task, tasks, config)} ${idLabel}${retryPart}${assigneePart} ${subject}${blockedBySuffix(task)}${durationSuffix(task, nowMs)}`;
}

interface HeaderParts {
  base: string;
  totalSegment: string;
  doneSegment: string;
  pausedSegment?: string;
  deletedSegment?: string;
  activeTotal?: string;
}

function buildHeaderParts(tasks: Task[], nowMs: number, timing?: ActiveTiming): HeaderParts {
  const done = tasks.filter((task) => task.status === "completed").length;
  const paused = tasks.filter((task) => task.status === "paused").length;
  const deleted = tasks.filter((task) => task.status === "deleted").length;
  const totalSegment = `${tasks.length} total`;
  const doneSegment = `${done} done`;
  const pausedSegment = paused > 0 ? `${paused} paused` : undefined;
  const deletedSegment = deleted > 0 ? `${deleted} deleted` : undefined;
  let base = `● Tasks · ${totalSegment} · ${doneSegment}`;
  if (pausedSegment !== undefined) base += ` · ${pausedSegment}`;
  if (deletedSegment !== undefined) base += ` · ${deletedSegment}`;
  const hasStarted = tasks.some((task) => task.attempt > 0 || task.status === "in_progress");
  const parts = { base, totalSegment, doneSegment, pausedSegment, deletedSegment };
  return hasStarted ? { ...parts, activeTotal: formatActiveTotal(timing, tasks, nowMs) } : parts;
}

/** Plain-text widget lines. Empty list yields no lines. `nowMs` fixes the elapsed clock for deterministic rendering; `timing` supplies the global union time. */
export function buildWidgetLines(tasks: Task[], nowMs: number = Date.now(), timing?: ActiveTiming, config: PiTasksConfig = DEFAULT_CONFIG): string[] {
  if (tasks.length === 0) return [];
  const sorted = [...tasks].sort((a, b) => a.id - b.id);
  const { base, activeTotal } = buildHeaderParts(sorted, nowMs, timing);
  const header = activeTotal === undefined ? base : `${base} · ${activeTotal}`;
  const idWidth = idColumnWidth(sorted);
  const retryWidth = retryColumnWidth(sorted);
  const assigneeWidth = assigneeColumnWidth(sorted, config);
  return [header, ...sorted.map((task) => formatTaskLine(task, nowMs, config, idWidth, retryWidth, assigneeWidth, sorted))];
}

/**
 * Fixed glyph theme color derived from status (and the attempt count for
 * pending). Fresh pending tasks render dim/gray; pending tasks that have run
 * at least once render yellow/warning so retries stay visible across reloads.
 */
export function glyphThemeColor(task: Task): string {
  if (task.status === "in_progress" || task.status === "completed") return "success";
  if (task.status === "paused") return "warning";
  if (task.status === "deleted") return "dim";
  return task.attempt > 0 ? "warning" : "dim";
}

/** Truncate every line to `width` visible columns. Non-positive widths pass through. */
function fitLinesToWidth(lines: string[], width: number | undefined): string[] {
  if (width === undefined || !Number.isFinite(width) || width <= 0) return lines;
  return lines.map((line) => truncateToWidth(line, width));
}

/**
 * Themed widget lines. Falls back to plain lines if the theme rejects a color.
 * When `width` is a positive finite number, every emitted line is truncated to
 * fit that many visible columns (ANSI-aware, colors preserved). A numeric
 * `inProgressFrame` selects the animation frame; `false` retains the legacy
 * same-width blank behavior. Plain-text lines use the first frame.
 * `nowMs` fixes the elapsed clock for deterministic rendering. Elapsed text
 * always renders dim; the plain fallback already includes it.
 */
export function renderWidgetLines(tasks: Task[], theme: ThemeLike, width?: number, inProgressFrame: boolean | number = true, nowMs: number = Date.now(), timing?: ActiveTiming, config: PiTasksConfig = DEFAULT_CONFIG): string[] {
  const plain = buildWidgetLines(tasks, nowMs, timing, config);
  if (plain.length === 0) return plain;
  try {
    const sorted = [...tasks].sort((a, b) => a.id - b.id);
    const { totalSegment, doneSegment, pausedSegment, deletedSegment, activeTotal } = buildHeaderParts(sorted, nowMs, timing);
    const title = theme.fg("accent", `● ${theme.bold("Tasks")}`);
    let tail = ` · ${totalSegment} · ${doneSegment}`;
    if (pausedSegment !== undefined) tail += ` · ${pausedSegment}`;
    if (deletedSegment !== undefined) tail += ` · ${deletedSegment}`;
    if (activeTotal !== undefined) tail += ` · ${activeTotal}`;
    const themedHeader = `${title}${theme.fg("dim", tail)}`;
    const idWidth = idColumnWidth(sorted);
    const retryWidth = retryColumnWidth(sorted);
    const assigneeWidth = assigneeColumnWidth(sorted, config);
    const lines = [themedHeader];
    const frame = typeof inProgressFrame === "number" ? inProgressFrame : 0;
    for (const task of sorted) {
      const assigneeText = config.enableAssignee ? assigneeField(task, assigneeWidth) : "";
      const idLabel = `#${task.id}`.padEnd(idWidth);
      let retryPart = remainingRetries(task);
      if (retryWidth > 0) {
        const label = retryPart.trim();
        retryPart = label === "" ? ` ${" ".repeat(retryWidth)}` : ` ${label.padEnd(retryWidth)}`;
      }
      const idPart = theme.fg("dim", `${idLabel}${retryPart}`);
      const suffix = durationSuffix(task, nowMs);
      const elapsedSuffix = suffix === "" ? "" : ` ${theme.fg("dim", suffix.trim())}`;
      const completedSubject = theme.fg("dim", task.subject);
      const completedAssignee = assigneeText ? ` ${theme.fg("dim", assigneeText)}` : "";
      if (task.status === "deleted") {
        const deletedSubject = theme.fg("dim", theme.strikethrough(task.subject));
        const deletedAssignee = assigneeText ? ` ${theme.fg("dim", theme.strikethrough(assigneeText))}` : "";
        lines.push(`  ${theme.fg(glyphThemeColor(task), statusGlyphFor(task, sorted, config))} ${idPart}${deletedAssignee} ${deletedSubject}${elapsedSuffix}`);
      } else if (task.status === "paused") {
        const pausedAssignee = assigneeText ? ` ${theme.fg("text", assigneeText)}` : "";
        const pausedSubject = theme.fg("text", task.subject);
        lines.push(`  ${theme.fg(glyphThemeColor(task), statusGlyphFor(task, sorted, config))} ${idPart}${pausedAssignee} ${pausedSubject}${elapsedSuffix}`);
      } else if (task.status === "completed") {
        lines.push(`  ${theme.fg(glyphThemeColor(task), statusGlyphFor(task, sorted, config))} ${idPart}${completedAssignee} ${completedSubject}${elapsedSuffix}`);
      } else if (task.status === "in_progress") {
        const assignee = assigneeText ? ` ${theme.fg("text", theme.bold(assigneeText))}` : "";
        const glyph = inProgressFrame === false
          ? blankGlyph(task, config)
          : statusGlyphFor(task, sorted, config, frame);
        lines.push(`  ${theme.fg(glyphThemeColor(task), glyph)} ${idPart}${assignee} ${theme.fg("text", theme.bold(task.subject))}${elapsedSuffix}`);
      } else {
        const assignee = assigneeText ? ` ${theme.fg("text", assigneeText)}` : "";
        const dependencies = blockedBySuffix(task);
        lines.push(`  ${theme.fg(glyphThemeColor(task), statusGlyphFor(task, sorted, config))} ${idPart}${assignee} ${theme.fg("text", task.subject)}${dependencies ? theme.fg("dim", dependencies) : ""}${elapsedSuffix}`);
      }
    }
    return fitLinesToWidth(lines, width);
  } catch {
    return fitLinesToWidth(plain, width);
  }
}

/** Minimal TUI surface needed to read the live terminal width and request redraws for blinking/elapsed updates. */
export type TuiWidthLike = {
  terminal?: { columns?: unknown } | undefined;
  requestRender?: ((force?: boolean) => void) | undefined;
  renderNow?: ((force?: boolean) => void) | undefined;
};

/** Blink period for in-progress glyphs. */
export const BLINK_INTERVAL_MS = 250;

/** Redraw period for elapsed durations. Runs only while an in-progress task is shown. */
export const ELAPSED_INTERVAL_MS = 1000;

function hasInProgress(tasks: Task[]): boolean {
  return tasks.some((task) => task.status === "in_progress");
}

/** Clock override for deterministic rendering/tests. A fixed epoch-ms pins elapsed output; a function is read on every render for live ticking. */
export type NowProvider = number | (() => number);

function resolveNow(now: NowProvider | undefined, fallback: number | undefined): number {
  // A per-render override wins over the provider clock.
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  if (typeof now === "function") {
    try {
      const value = now();
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch {
      // Fall through to Date.now() below.
    }
  } else if (typeof now === "number" && Number.isFinite(now)) {
    return now;
  }
  return Date.now();
}

/** Request a widget redraw via `requestRender()`, falling back to `renderNow()`. */
function requestRedraw(tui: TuiWidthLike): void {
  if (typeof tui?.requestRender === "function") tui.requestRender();
  else if (typeof tui?.renderNow === "function") tui.renderNow();
}

/**
 * Widget component factory. Reads the live `tui.terminal.columns` on every
 * render (so lines keep fitting after resizes); an explicit positive render
 * width wins when the TUI passes one. Elapsed durations read the live clock
 * on every render (or the supplied `now` provider / `render()` override for
 * deterministic tests).
 *
 * When the current snapshot contains an in-progress task, a 250 ms timer
 * advances its configured frames (or legacy character/blank blink) and requests
 * a redraw via `tui.requestRender()` (falling back to `tui.renderNow()`). A
 * separate 1 s timer keeps elapsed durations current. `update()` replaces the
 * rendered snapshot in place and starts or stops both timers as tasks enter or
 * leave `in_progress`, so store changes do not require replacing the host
 * widget. `dispose()` clears all timers. Follows the `Loader` component pattern
 * in `@earendil-works/pi-tui` (interval + `requestRender`, cleared on stop).
 */
export interface TaskWidgetComponent {
  render(width?: number, nowMs?: number): string[];
  update(snapshot: Task[], timing?: ActiveTiming): void;
  invalidate(): void;
  dispose(): void;
}

export function createTaskWidget(
  snapshot: Task[],
  tui: TuiWidthLike,
  theme: ThemeLike,
  now?: NowProvider,
  timing?: ActiveTiming,
  config: PiTasksConfig = DEFAULT_CONFIG,
): TaskWidgetComponent {
  let currentSnapshot = snapshot;
  let currentTiming = timing;
  let frame = 0;
  let blinkTimer: ReturnType<typeof setInterval> | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const stopTimers = () => {
    if (blinkTimer !== undefined) {
      clearInterval(blinkTimer);
      blinkTimer = undefined;
    }
    if (elapsedTimer !== undefined) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  };

  const syncTimers = () => {
    if (!hasInProgress(currentSnapshot)) {
      stopTimers();
      frame = 0;
      return;
    }
    if (blinkTimer === undefined) {
      blinkTimer = setInterval(() => {
        frame = (frame + 1) % inProgressFrames(config).length;
        requestRedraw(tui);
      }, BLINK_INTERVAL_MS);
    }
    if (elapsedTimer === undefined) {
      elapsedTimer = setInterval(() => {
        requestRedraw(tui);
      }, ELAPSED_INTERVAL_MS);
    }
  };

  syncTimers();
  return {
    render: (width?: number, nowMs?: number) => {
      const live = tui?.terminal?.columns;
      const resolved =
        typeof width === "number" && Number.isFinite(width) && width > 0
          ? width
          : typeof live === "number" && Number.isFinite(live) && live > 0
            ? live
            : undefined;
      return renderWidgetLines(currentSnapshot, theme, resolved, frame, resolveNow(now, nowMs), currentTiming, config);
    },
    update: (nextSnapshot: Task[], nextTiming?: ActiveTiming) => {
      if (disposed) return;
      currentSnapshot = nextSnapshot;
      currentTiming = nextTiming;
      syncTimers();
      requestRedraw(tui);
    },
    invalidate: () => {},
    dispose: () => {
      disposed = true;
      stopTimers();
    },
  };
}
