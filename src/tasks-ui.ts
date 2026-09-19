/**
 * Small terminal overlay for `/tasks view`: left task list, right details.
 * Pure helpers plus a keyboard-driven component using public pi-tui APIs.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import type { Task } from "./types.js";
import type { ThemeLike } from "./widget.js";
import { blockedBySuffix, statusGlyph } from "./widget.js";

/** Visible detail rows in the right pane; PageUp/PageDown move by this amount. */
export const TASK_VIEWER_PAGE_SIZE = 10;

/** Single-line label for the left task list. */
export function taskRowLabel(task: Task): string {
  return `${statusGlyph(task)} #${task.id} (${task.attempt}/${task.maxAttempts}) ${task.subject}${blockedBySuffix(task)}`;
}

/** Full detail lines for the right pane (plain text; the component truncates). */
export function buildTaskDetailLines(task: Task): string[] {
  const lines: string[] = [
    `Status: ${task.status}`,
    `Task: #${task.id} (${task.attempt}/${task.maxAttempts})`,
    `Assignee: ${task.assignee ?? "(none)"}`,
    `Subject: ${task.subject}`,
    ...task.description.split("\n").map((line, index) => `${index === 0 ? "Description" : "           "}: ${line}`),
    `Blocked by: ${task.blockedBy.length === 0 ? "(none)" : task.blockedBy.map((id) => `#${id}`).join(", ")}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
  ];
  if (task.startedAt !== undefined) lines.push(`Started: ${task.startedAt}`);
  if (task.tookMs !== undefined) lines.push(`Took: ${task.tookMs}ms`);
  lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
  lines.push(`Log (${task.log.length}):`);
  for (const entry of task.log) lines.push(`  [${entry.timestamp}] ${entry.message}`);
  return lines;
}

function fit(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  if (visibleWidth(line) <= width) return line;
  return truncateToWidth(line, width);
}

function isKey(data: string, id: Parameters<typeof matchesKey>[1]): boolean {
  try {
    return matchesKey(data, id);
  } catch {
    return false;
  }
}

function matchesBinding(
  keybindings: TasksViewerOptions["keybindings"],
  data: string,
  binding: "tui.editor.cursorUp" | "tui.editor.cursorDown",
): boolean {
  if (!keybindings) return false;
  try {
    return keybindings.matches(data, binding);
  } catch {
    return false;
  }
}

function addBorder(lines: string[], width: number, theme?: ThemeLike): string[] {
  const paint = (text: string): string => {
    if (!theme) return text;
    try {
      return theme.fg("border", text);
    } catch {
      return text;
    }
  };
  if (width === 1) return [paint("╷"), ...lines.map(() => paint("│")), paint("╵")];
  const innerWidth = width - 2;
  const horizontal = "─".repeat(innerWidth);
  return [
    paint(`┌${horizontal}┐`),
    ...lines.map((line) => {
      const content = fit(line, innerWidth);
      return `${paint("│")}${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))}${paint("│")}`;
    }),
    paint(`└${horizontal}┘`),
  ];
}

export interface TasksViewerOptions {
  /** Called to close the overlay. */
  done: () => void;
  theme?: ThemeLike;
  /** Request a redraw after navigation (the TUI object from the custom factory). */
  tui?: { requestRender?: ((force?: boolean) => void) | undefined; renderNow?: ((force?: boolean) => void) | undefined };
  /** Resolves the configured `tui.editor.cursorUp` / `tui.editor.cursorDown` bindings. */
  keybindings?: Pick<KeybindingsManager, "matches">;
  /** Visible detail rows; defaults to TASK_VIEWER_PAGE_SIZE. */
  pageSize?: number;
}

export type TasksViewer = {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
  getSelected(): number;
  getDetailOffset(): number;
};

/**
 * Keyboard-driven two-column viewer. Selection follows the configured
 * `tui.editor.cursorUp` / `tui.editor.cursorDown` bindings (detail scroll
 * resets); PageUp/PageDown scrolls the detail pane; Escape or Ctrl+C closes.
 */
export function createTasksViewer(tasks: Task[], options: TasksViewerOptions): TasksViewer {
  const snapshot = [...tasks].sort((a, b) => a.id - b.id);
  const pageSize =
    typeof options.pageSize === "number" && Number.isFinite(options.pageSize) && options.pageSize > 0
      ? Math.floor(options.pageSize)
      : TASK_VIEWER_PAGE_SIZE;
  let selected = 0;
  let detailOffset = 0;

  const detailLines = (): string[] =>
    snapshot.length === 0 ? [] : buildTaskDetailLines(snapshot[Math.min(selected, snapshot.length - 1)]);

  function maxOffset(): number {
    return Math.max(0, detailLines().length - pageSize);
  }

  function redraw(): void {
    try {
      if (typeof options.tui?.requestRender === "function") options.tui.requestRender();
      else if (typeof options.tui?.renderNow === "function") options.tui.renderNow();
    } catch {
      // Redraws are best-effort in tests and teardown.
    }
  }

  function header(): string {
    const plain = `Tasks (${snapshot.length})`;
    if (!options.theme) return plain;
    try {
      return options.theme.fg("accent", plain);
    } catch {
      return plain;
    }
  }

  const HINT = "Up/Down select · PgUp/PgDn scroll · Esc close";

  return {
    render(width: number) {
      if (!Number.isFinite(width) || width <= 0) return [];
      const innerWidth = Math.max(0, width - 2);
      const lines: string[] = [];
      if (snapshot.length === 0) {
        return addBorder([fit(header(), innerWidth), fit("No tasks.", innerWidth), fit(HINT, innerWidth)], width, options.theme);
      }
      const selectedTask = snapshot[Math.min(selected, snapshot.length - 1)];
      const allDetail = buildTaskDetailLines(selectedTask);
      const offset = Math.min(detailOffset, Math.max(0, allDetail.length - pageSize));
      const visibleDetail = allDetail.slice(offset, offset + pageSize);

      // Narrow terminals stack list above details instead of squeezing columns.
      if (innerWidth < 40) {
        lines.push(fit(header(), innerWidth));
        snapshot.forEach((task, index) => {
          lines.push(fit(`${index === selected ? "> " : "  "}${taskRowLabel(task)}`, innerWidth));
        });
        lines.push(fit("—", innerWidth));
        for (const line of visibleDetail) lines.push(fit(line, innerWidth));
        lines.push(fit(HINT, innerWidth));
        return addBorder(lines, width, options.theme);
      }

      const leftW = Math.max(18, Math.min(32, Math.floor(innerWidth * 0.35)));
      const rightW = innerWidth - leftW - 3;
      lines.push(fit(header(), innerWidth));
      const rowCount = Math.max(snapshot.length, visibleDetail.length);
      for (let i = 0; i < rowCount; i++) {
        const leftRaw = i < snapshot.length ? `${i === selected ? "> " : "  "}${taskRowLabel(snapshot[i])}` : "";
        const leftFit = fit(leftRaw, leftW);
        const leftPadded = leftFit + " ".repeat(Math.max(0, leftW - visibleWidth(leftFit)));
        const rightFit = rightW > 0 ? fit(visibleDetail[i] ?? "", rightW) : "";
        lines.push(rightW > 0 ? `${leftPadded} │ ${rightFit}` : leftPadded);
      }
      lines.push(fit(HINT, innerWidth));
      return addBorder(lines, width, options.theme);
    },
    handleInput(data: string) {
      if (data === "\x1b" || data === "\x03" || isKey(data, "escape") || isKey(data, "ctrl+c")) {
        options.done();
        return;
      }
      if (snapshot.length === 0) return;
      if (data === "\x1b[A" || isKey(data, "up") || matchesBinding(options.keybindings, data, "tui.editor.cursorUp")) {
        selected = (selected - 1 + snapshot.length) % snapshot.length;
        detailOffset = 0;
        redraw();
        return;
      }
      if (data === "\x1b[B" || isKey(data, "down") || matchesBinding(options.keybindings, data, "tui.editor.cursorDown")) {
        selected = (selected + 1) % snapshot.length;
        detailOffset = 0;
        redraw();
        return;
      }
      if (data === "\x1b[5~" || isKey(data, "pageUp")) {
        detailOffset = Math.max(0, detailOffset - pageSize);
        redraw();
        return;
      }
      if (data === "\x1b[6~" || isKey(data, "pageDown")) {
        detailOffset = Math.min(maxOffset(), detailOffset + pageSize);
        redraw();
      }
    },
    invalidate() {},
    dispose() {},
    getSelected() {
      return selected;
    },
    getDetailOffset() {
      return detailOffset;
    },
  };
}
