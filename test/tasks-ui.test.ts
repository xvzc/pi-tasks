import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildTaskDetailLines,
  createTasksViewer,
  TASK_VIEWER_PAGE_SIZE,
  taskRowLabel,
} from "../src/tasks-ui.js";
import type { Task } from "../src/types.js";

function task(overrides: Partial<Task> & { id: number; subject: string }): Task {
  return {
    description: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 9,
    blockedBy: [],
    metadata: {},
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("detail content", () => {
  it("includes status, id/attempts, assignee, description, blockedBy, timestamps, metadata, and log", () => {
    const lines = buildTaskDetailLines(
      task({
        id: 2,
        subject: "Ship it",
        description: "details here",
        status: "in_progress",
        attempt: 1,
        assignee: "api",
        blockedBy: [1],
        startedAt: "2026-01-01T01:00:00.000Z",
        metadata: { key: "value" },
        log: [{ timestamp: "2026-01-01T02:00:00.000Z", message: "note" }],
      }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("in_progress");
    expect(joined).toContain("#2 (1/9)");
    expect(joined).toContain("api");
    expect(joined).toContain("details here");
    expect(joined).toContain("#1");
    expect(joined).toContain("2026-01-01T00:00:00.000Z");
    expect(joined).toContain('{"key":"value"}');
    expect(joined).toContain("note");
    expect(taskRowLabel(task({ id: 3, subject: "Hi" }))).toContain("#3 (0/9)");
  });

  it("appends blockedBy ids to pending row subjects only", () => {
    expect(taskRowLabel(task({ id: 3, subject: "Hi", blockedBy: [1, 2] }))).toBe(
      "□ #3 (0/9) Hi → (1, 2)",
    );
    expect(taskRowLabel(task({ id: 3, subject: "Hi", status: "in_progress", blockedBy: [1, 2] }))).not.toContain("→");
    expect(taskRowLabel(task({ id: 3, subject: "Hi", status: "completed", blockedBy: [1, 2] }))).not.toContain("→");
  });
});

describe("viewer rendering", () => {
  it("renders a two-column view within width and handles empty lists", () => {
    const done = vi.fn();
    const viewer = createTasksViewer(
      [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", status: "completed" })],
      { done },
    );
    const lines = viewer.render(80);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(lines.join("\n")).toContain("Tasks (2)");
    expect(lines[0]).toBe(`┌${"─".repeat(78)}┐`);
    expect(lines.at(-1)).toBe(`└${"─".repeat(78)}┘`);
    expect(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
    expect(lines.join("\n")).toContain("│");

    const empty = createTasksViewer([], { done });
    const emptyLines = empty.render(80);
    expect(emptyLines[0]).toBe(`┌${"─".repeat(78)}┐`);
    expect(emptyLines.at(-1)).toBe(`└${"─".repeat(78)}┘`);
    expect(emptyLines.join("\n")).toContain("No tasks");
    empty.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("stays safe at constrained widths, including wide characters", () => {
    const done = vi.fn();
    const wide = createTasksViewer(
      [
        task({ id: 1, subject: "日本語のとても長いサブジェクト".repeat(6), description: "説明".repeat(40) }),
        task({ id: 2, subject: "b", status: "in_progress", log: [{ timestamp: "2026-01-01T00:00:00.000Z", message: "x".repeat(200) }] }),
      ],
      { done },
    );
    for (const width of [80, 39, 20, 10, 5, 2, 1]) {
      const lines = wide.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(() => wide.render(0)).not.toThrow();
  });
});

describe("viewer border theme and keybindings", () => {
  const threeTasks = () => [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }), task({ id: 3, subject: "c" })];
  const borderTheme = {
    fg: (color: string, text: string) => (color === "border" ? `\x1b[90m${text}\x1b[39m` : text),
    bold: (text: string) => text,
    strikethrough: (text: string) => text,
  };

  it("paints the outer border with the theme border color", () => {
    const done = vi.fn();
    const viewer = createTasksViewer(threeTasks(), { done, theme: borderTheme });
    const lines = viewer.render(80);
    expect(lines[0]).toBe(`\x1b[90m┌${"─".repeat(78)}┐\x1b[39m`);
    expect(lines.at(-1)).toBe(`\x1b[90m└${"─".repeat(78)}┘\x1b[39m`);
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
  });

  it("falls back to a plain border when theme coloring throws", () => {
    const done = vi.fn();
    const throwing = {
      fg: (): string => {
        throw new Error("no color");
      },
      bold: (text: string) => text,
      strikethrough: (text: string) => text,
    };
    const viewer = createTasksViewer(threeTasks(), { done, theme: throwing });
    const lines = viewer.render(80);
    expect(lines[0]).toBe(`┌${"─".repeat(78)}┐`);
    expect(lines.at(-1)).toBe(`└${"─".repeat(78)}┘`);
  });

  it("moves selection with the configured cursorUp/cursorDown bindings", () => {
    const done = vi.fn();
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.cursorUp": ["up", "ctrl+p"],
      "tui.editor.cursorDown": ["down", "ctrl+n"],
    });
    const viewer = createTasksViewer(threeTasks(), { done, keybindings });
    viewer.handleInput("\x0e"); // Ctrl+N
    expect(viewer.getSelected()).toBe(1);
    viewer.handleInput("\x10"); // Ctrl+P
    expect(viewer.getSelected()).toBe(0);
    viewer.handleInput("\x1b[B");
    expect(viewer.getSelected()).toBe(1);
    expect(done).not.toHaveBeenCalled();
  });

  it("ignores configured bindings without a keybindings manager", () => {
    const done = vi.fn();
    const viewer = createTasksViewer(threeTasks(), { done });
    viewer.handleInput("\x0e");
    expect(viewer.getSelected()).toBe(0);
  });
});

describe("viewer navigation", () => {
  it("moves selection with Up/Down and resets detail scroll", () => {
    const done = vi.fn();
    const viewer = createTasksViewer(
      [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }), task({ id: 3, subject: "c" })],
      { done, pageSize: 5 },
    );
    expect(viewer.getSelected()).toBe(0);
    viewer.handleInput("\x1b[B");
    expect(viewer.getSelected()).toBe(1);
    viewer.handleInput("\x1b[A");
    expect(viewer.getSelected()).toBe(0);
    expect(done).not.toHaveBeenCalled();
    expect(viewer.render(80).join("\n")).toContain("#1");
  });

  it("scrolls details with PageUp/PageDown and closes on Escape or Ctrl+C", () => {
    const done = vi.fn();
    const long = task({
      id: 1,
      subject: "a",
      description: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    });
    const viewer = createTasksViewer([long], { done, pageSize: 5 });
    expect(TASK_VIEWER_PAGE_SIZE).toBe(10);
    expect(viewer.getDetailOffset()).toBe(0);
    viewer.handleInput("\x1b[6~");
    expect(viewer.getDetailOffset()).toBe(5);
    viewer.handleInput("\x1b[5~");
    expect(viewer.getDetailOffset()).toBe(0);
    viewer.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
    viewer.handleInput("\x03");
    expect(done).toHaveBeenCalledTimes(2);
  });
});
