/**
 * Presentational task rendering. Pure functions over task state: this module
 * never reads or writes the store and never changes lifecycle/model semantics.
 *
 * Each line shows the numeric ID with its `(<attempt>/<maxAttempts>)` counter,
 * the optional `[assignee]`, and the subject. `in_progress` lines append the
 * running per-attempt duration measured from `startedAt` to the supplied
 * current time (`Date.now()` by default; pass an explicit `nowMs` for
 * deterministic rendering/tests), showing `0s` immediately at zero. `completed`
 * lines append only the frozen `<duration>` for the last completed attempt
 * (`tookMs`, or the `createdAt` to `updatedAt` span for legacy tasks).
 * `pending` lines show no duration: a new attempt shows `0s` on entry into
 * `in_progress`.
 * The header always shows the total count and the done count (including
 * `(0 done)`). It appends the global accumulated active (wall-clock union)
 * time only after a task has entered `in_progress`; the themed header renders
 * that time dim/gray. Statuses are visually distinct (`□` pending, `■` in progress, `■`
 * completed). The optional `[assignee]` always uses the same color, weight, and
 * decoration as the subject. Pending assignees and subjects use the default
 * text color while the pending glyph remains gray. The optional task `color`
 * tints only the in-progress and completed status glyphs; both render green
 * by default. Elapsed/completed duration text renders dim/gray in themed lines
 * and is appended plain after the subject in the text fallback.
 * In-progress glyphs blink by alternating with a same-width blank.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Task } from "./types.js";

export type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export function statusGlyph(task: Task): string {
  return task.status === "pending" ? "□" : "■";
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
  if (task.status === "completed") {
    return ` ${tookDisplay(task)}`;
  }
  return "";
}

/** Pending-only dependency suffix appended after the subject. */
export function blockedBySuffix(task: Task): string {
  return task.status === "pending" && task.blockedBy.length > 0
    ? ` → (${task.blockedBy.join(", ")})`
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

/** Plain-text line: `#<id> (<attempt>/<maxAttempts>) [assignee] subject`, a pending-only ` → (<blockedBy>)` suffix, and status-specific duration. No colors. */
export function formatTaskLine(task: Task, nowMs: number = Date.now()): string {
  const assignee = task.assignee !== undefined ? ` [${task.assignee}]` : "";
  return `  ${statusGlyph(task)} #${task.id} (${task.attempt}/${task.maxAttempts})${assignee} ${task.subject}${blockedBySuffix(task)}${durationSuffix(task, nowMs)}`;
}

interface HeaderParts {
  base: string;
  activeTotal?: string;
}

function buildHeaderParts(tasks: Task[], nowMs: number, timing?: ActiveTiming): HeaderParts {
  const done = tasks.filter((task) => task.status === "completed").length;
  const taskLabel = tasks.length === 1 ? "task" : "tasks";
  const base = `● ${tasks.length} ${taskLabel} (${done} done)`;
  const hasStarted = tasks.some((task) => task.attempt > 0 || task.status === "in_progress");
  return hasStarted ? { base, activeTotal: formatActiveTotal(timing, tasks, nowMs) } : { base };
}

/** Plain-text widget lines. Empty list yields no lines. `nowMs` fixes the elapsed clock for deterministic rendering; `timing` supplies the global union time. */
export function buildWidgetLines(tasks: Task[], nowMs: number = Date.now(), timing?: ActiveTiming): string[] {
  if (tasks.length === 0) return [];
  const sorted = [...tasks].sort((a, b) => a.id - b.id);
  const { base, activeTotal } = buildHeaderParts(sorted, nowMs, timing);
  const header = activeTotal === undefined ? base : `${base} ${activeTotal}`;
  return [header, ...sorted.map((task) => formatTaskLine(task, nowMs))];
}

/**
 * Map a user-supplied task color to a known theme color. Unknown values yield
 * `undefined` (callers fall back to the default glyph color) because
 * `theme.fg` throws on unknown colors.
 */
export function themeColorFor(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  const name = color.trim().toLowerCase();
  const mapping: Record<string, string> = {
    red: "error",
    green: "success",
    yellow: "warning",
    blue: "accent",
    cyan: "accent",
    magenta: "accent",
    purple: "accent",
    gray: "dim",
    grey: "dim",
    white: "text",
    black: "dim",
  };
  return mapping[name];
}

/** Truncate every line to `width` visible columns. Non-positive widths pass through. */
function fitLinesToWidth(lines: string[], width: number | undefined): string[] {
  if (width === undefined || !Number.isFinite(width) || width <= 0) return lines;
  return lines.map((line) => truncateToWidth(line, width));
}

/**
 * Themed widget lines. Falls back to plain lines if the theme rejects a color.
 * When `width` is a positive finite number, every emitted line is truncated to
 * fit that many visible columns (ANSI-aware, colors preserved). When
 * `blinkOn` is false, in-progress glyphs render as a same-width blank (the
 * widget toggles this to blink); plain-text lines always show steady glyphs.
 * `nowMs` fixes the elapsed clock for deterministic rendering. Elapsed text
 * always renders dim; the plain fallback already includes it.
 */
export function renderWidgetLines(tasks: Task[], theme: ThemeLike, width?: number, blinkOn = true, nowMs: number = Date.now(), timing?: ActiveTiming): string[] {
  const plain = buildWidgetLines(tasks, nowMs, timing);
  if (plain.length === 0) return plain;
  try {
    const sorted = [...tasks].sort((a, b) => a.id - b.id);
    const { base, activeTotal } = buildHeaderParts(sorted, nowMs, timing);
    const themedHeader = activeTotal === undefined
      ? theme.fg("accent", base)
      : `${theme.fg("accent", base)} ${theme.fg("dim", activeTotal)}`;
    const lines = [themedHeader];
    for (const task of sorted) {
      const assigneeText = task.assignee !== undefined ? ` [${task.assignee}]` : "";
      const idPart = theme.fg("dim", `#${task.id} (${task.attempt}/${task.maxAttempts})`);
      const suffix = durationSuffix(task, nowMs);
      const elapsedSuffix = suffix === "" ? "" : ` ${theme.fg("dim", suffix.trim())}`;
      const completedSubject = theme.fg("dim", task.subject);
      const completedAssignee = assigneeText ? theme.fg("dim", assigneeText) : "";
      if (task.status === "completed") {
        const glyphColor = themeColorFor(task.color) ?? "success";
        lines.push(`  ${theme.fg(glyphColor, "■")} ${idPart}${completedAssignee} ${completedSubject}${elapsedSuffix}`);
      } else if (task.status === "in_progress") {
        const glyphColor = themeColorFor(task.color) ?? "success";
        const assignee = assigneeText ? theme.fg("success", theme.bold(assigneeText)) : "";
        lines.push(`  ${theme.fg(glyphColor, blinkOn ? "■" : " ")} ${idPart}${assignee} ${theme.fg("success", theme.bold(task.subject))}${elapsedSuffix}`);
      } else {
        const assignee = assigneeText ? theme.fg("text", assigneeText) : "";
        const dependencies = blockedBySuffix(task);
        lines.push(`  ${theme.fg("dim", "□")} ${idPart}${assignee} ${theme.fg("text", task.subject)}${dependencies ? theme.fg("dim", dependencies) : ""}${elapsedSuffix}`);
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
 * When the snapshot contains an in-progress task, a 250 ms timer alternates
 * the in-progress glyph with a same-width blank and requests a redraw via
 * `tui.requestRender()` (falling back to `tui.renderNow()`). The blink timer
 * never starts without an in-progress task. A separate 1 s timer requests a
 * redraw only while an in-progress task is shown so elapsed durations stay
 * current. `dispose()` clears all timers, so redraws stop
 * when the host replaces or removes the widget (the host disposes the
 * previous widget on every `setWidget`, including refreshes after store
 * changes and teardown). Follows the `Loader` component pattern in
 * `@earendil-works/pi-tui` (interval + `requestRender`, cleared on stop).
 */
export function createTaskWidget(
  snapshot: Task[],
  tui: TuiWidthLike,
  theme: ThemeLike,
  now?: NowProvider,
  timing?: ActiveTiming,
): { render: (width?: number, nowMs?: number) => string[]; invalidate: () => void; dispose: () => void } {
  let blinkOn = true;
  let blinkTimer: ReturnType<typeof setInterval> | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  if (hasInProgress(snapshot)) {
    blinkTimer = setInterval(() => {
      blinkOn = !blinkOn;
      requestRedraw(tui);
    }, BLINK_INTERVAL_MS);
  }
  if (hasInProgress(snapshot)) {
    elapsedTimer = setInterval(() => {
      requestRedraw(tui);
    }, ELAPSED_INTERVAL_MS);
  }
  return {
    render: (width?: number, nowMs?: number) => {
      const live = tui?.terminal?.columns;
      const resolved =
        typeof width === "number" && Number.isFinite(width) && width > 0
          ? width
          : typeof live === "number" && Number.isFinite(live) && live > 0
            ? live
            : undefined;
      return renderWidgetLines(snapshot, theme, resolved, blinkOn, resolveNow(now, nowMs), timing);
    },
    invalidate: () => {},
    dispose: () => {
      if (blinkTimer !== undefined) {
        clearInterval(blinkTimer);
        blinkTimer = undefined;
      }
      if (elapsedTimer !== undefined) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
    },
  };
}
