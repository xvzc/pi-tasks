import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { DEFAULT_CONFIG, loadPiTasksConfig } from "../src/config.js";
import registerExtension from "../src/index.js";
import { TaskStore } from "../src/store.js";
import { TASK_STATUSES, isTaskStatus } from "../src/types.js";
import type { Task } from "../src/types.js";
import { taskRowLabel, buildTaskDetailLines } from "../src/tasks-ui.js";
import {
  buildWidgetLines,
  formatTaskLine,
  renderWidgetLines,
  statusGlyph,
  type ThemeLike } from "../src/widget.js";

const dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore(): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-paused-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

function widgetTask(overrides: Partial<Task> & { id: number; subject: string }): Task {
  return {
    description: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 9,
    blockedBy: [],
    reviewOf: [],
    metadata: {},
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides };
}

const fakeTheme: ThemeLike = {
  fg: (_color: string, text: string) => `<${_color}>${text}</>`,
  bold: (text: string) => `*${text}*`,
  strikethrough: (text: string) => `~${text}~` };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const timestamp = "2025-01-02T03:04:05.000Z";

function persistedTask(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    subject: `task ${id}`,
    description: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 9,
    blockedBy: [],
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides };
}

describe("paused status identity", () => {
  it("keeps paused and deleted in the task status type guards", () => {
    expect(TASK_STATUSES).toEqual(["pending", "in_progress", "paused", "completed", "deleted"]);
    expect(isTaskStatus("paused")).toBe(true);
    expect(isTaskStatus("deleted")).toBe(true);
    expect(isTaskStatus("bogus")).toBe(false);
  });

  it("loads version-1 persisted stores containing paused tasks without a version bump", async () => {
    const store = await freshStore();
    await writeFile(
      store.filePath,
      JSON.stringify({
        version: 1,
        nextId: 3,
        totalActiveMs: 0,
        tasks: [
          persistedTask(1, { status: "paused", attempt: 1, tookMs: 5000, log: [{ timestamp, message: "boom" }] }),
          persistedTask(2, { status: "completed", attempt: 1, tookMs: 1000 }),
        ] }),
    );
    const loaded = await TaskStore.load(store.filePath);
    expect(loaded.get(1)?.status).toBe("paused");
    expect(loaded.get(1)?.tookMs).toBe(5000);
    expect(loaded.list("paused").map((task) => task.id)).toEqual([1]);
    expect(loaded.list("completed").map((task) => task.id)).toEqual([2]);
  });

  it("maps legacy failed to paused and legacy retried pending to paused", async () => {
    const store = await freshStore();
    await writeFile(
      store.filePath,
      JSON.stringify({
        version: 1,
        nextId: 4,
        totalActiveMs: 0,
        tasks: [
          persistedTask(1, { status: "failed", attempt: 1, tookMs: 5000, log: [{ timestamp, message: "boom" }] }),
          persistedTask(2, { status: "pending", attempt: 2 }),
          persistedTask(3, { status: "pending", attempt: 0 }),
        ],
      }),
    );
    const loaded = await TaskStore.load(store.filePath);
    expect(loaded.get(1)?.status).toBe("paused");
    expect(loaded.get(1)?.tookMs).toBe(5000);
    expect(loaded.get(2)?.status).toBe("paused");
    expect(loaded.get(3)?.status).toBe("pending");
  });

  it("exposes paused through the task_update and task_list status schemas", async () => {
    const tools = new Map<string, any>();
    registerExtension({ on: () => {}, registerTool: (tool: any) => void tools.set(tool.name, tool), registerCommand: () => {} } as any);
    const updateStatus = JSON.stringify(
      (tools.get("task_update").parameters as any).properties.updates.items.properties.status,
    );
    const listStatus = JSON.stringify((tools.get("task_list").parameters as any).properties.status);
    expect(updateStatus).toContain("paused");
    expect(listStatus).toContain("paused");
  });

  it("filters paused tasks through the task_list tool", async () => {
    const tools = new Map<string, any>();
    registerExtension({ on: () => {}, registerTool: (tool: any) => void tools.set(tool.name, tool), registerCommand: () => {} } as any);
    const dir = await mkdtemp(join(tmpdir(), "pi-task-paused-tools-"));
    dirs.push(dir);
    const ctx: any = { cwd: dir, sessionManager: { getSessionId: () => "paused-filter" }, ui: { setWidget: () => {} } };
    await tools.get("task_create").execute("c1", { tasks: [{ subject: "a", description: "" }] }, undefined, undefined, ctx);
    await tools.get("task_create").execute("c2", { tasks: [{ subject: "b", description: "" }] }, undefined, undefined, ctx);
    await tools.get("task_update").execute("c-start", { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] }, undefined, undefined, ctx);
    await tools.get("task_update").execute("c3", { updates: [{ id: 1, status: "paused", appendLog: "broke" }] }, undefined, undefined, ctx);
    const filtered = await tools.get("task_list").execute("c4", { status: "paused" }, undefined, undefined, ctx);
    expect(filtered.isError).toBeUndefined();
    expect(JSON.parse(filtered.content[0].text).map((task: Task) => task.id)).toEqual([1]);
  });
});

describe("mandatory appendLog for every transition", () => {
  it("requires a non-empty appendLog on every real status transition", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const pending = await store.create({ subject: "a", description: "" });
    await expect(store.update(pending.id, { status: "in_progress" })).rejects.toThrow(/appendLog/);
    await expect(store.update(pending.id, { status: "in_progress", appendLog: "   " })).rejects.toThrow(/appendLog/);
    await expect(store.update(pending.id, { status: "deleted" })).rejects.toThrow(/appendLog/);

    await store.update(pending.id, { status: "in_progress", appendLog: "starting" });
    await expect(store.update(pending.id, { status: "paused" })).rejects.toThrow(/appendLog/);
    await expect(store.update(pending.id, { status: "completed" })).rejects.toThrow(/appendLog/);

    vi.setSystemTime(T0 + 10_000);
    await store.update(pending.id, { status: "paused", appendLog: "pausing for now" });
    expect(store.get(pending.id)?.status).toBe("paused");
    await expect(store.update(pending.id, { status: "in_progress" })).rejects.toThrow(/appendLog/);
    await store.update(pending.id, { status: "in_progress", appendLog: "resuming" });
    await store.update(pending.id, { status: "completed", appendLog: "done" });
    await expect(store.update(pending.id, { status: "in_progress" })).rejects.toThrow(/appendLog/);
    await store.update(pending.id, { status: "in_progress", appendLog: "rework" });
    expect(store.get(pending.id)?.status).toBe("in_progress");
  });

  it("rejects transitions outside the adjacency map", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await expect(store.update(task.id, { status: "paused", appendLog: "note" })).rejects.toThrow(
      "Task #1 cannot transition from pending to paused.",
    );
    await expect(store.update(task.id, { status: "completed", appendLog: "note" })).rejects.toThrow(
      "Task #1 cannot transition from pending to completed.",
    );
    await store.update(task.id, { status: "in_progress", appendLog: "start" });
    await expect(store.update(task.id, { status: "deleted", appendLog: "note" })).rejects.toThrow(
      "Task #1 cannot transition from in_progress to deleted.",
    );
    await store.update(task.id, { status: "paused", appendLog: "pause" });
    await expect(store.update(task.id, { status: "completed", appendLog: "note" })).rejects.toThrow(
      "Task #1 cannot transition from paused to completed.",
    );
  });

  it("lets paused -> paused patches through without a new log", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await store.update(task.id, { status: "in_progress", appendLog: "start" });
    await store.update(task.id, { status: "paused", appendLog: "first" });
    const relabeled = await store.update(task.id, { subject: "renamed" });
    expect(relabeled.subject).toBe("renamed");
    expect(relabeled.status).toBe("paused");
    expect(relabeled.log).toHaveLength(2);
  });

  it("rolls back every field when a pause transition is missing its log", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "original", description: "before", metadata: { keep: true } });
    await store.update(task.id, { status: "in_progress", appendLog: "start" });
    const before = store.get(task.id);
    const beforeDisk = await readFile(store.filePath, "utf8");
    await expect(
      store.update(task.id, { status: "paused", subject: "leaked", description: "leaked", metadata: { leaked: true } }),
    ).rejects.toThrow(/appendLog/);
    expect(store.get(task.id)).toEqual(before);
    await store.save();
    expect(await readFile(store.filePath, "utf8")).toBe(beforeDisk);
  });
});

describe("pause timing freeze and resume", () => {
  it("freezes the running attempt into tookMs, clears startedAt, and banks global active time", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await store.update(task.id, { status: "in_progress", appendLog: "note" });
    expect(store.activeTiming().activeSince).toBe(new Date(T0).toISOString());

    vi.setSystemTime(T0 + 65_000);
    const paused = await store.update(task.id, { status: "paused", appendLog: "boom" });
    expect(paused.tookMs).toBe(65_000);
    expect(paused.startedAt).toBeUndefined();
    expect(store.activeTiming()).toEqual({ totalActiveMs: 65_000 });
    expect(formatTaskLine(paused, T0 + 65_000)).toContain("1m 5s");
    // Frozen: rendering later does not advance the paused duration.
    expect(formatTaskLine(store.get(task.id) as Task, T0 + 600_000)).toContain("1m 5s");
  });

  it("resumes via paused -> in_progress with a fresh timer, cleared tookMs, and incremented attempt", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await store.update(task.id, { status: "in_progress", appendLog: "note" });
    vi.setSystemTime(T0 + 65_000);
    await store.update(task.id, { status: "paused", appendLog: "boom" });

    vi.setSystemTime(T0 + 600_000);
    const retried = await store.update(task.id, { status: "in_progress", appendLog: "note" });
    expect(retried.status).toBe("in_progress");
    expect(retried.attempt).toBe(2);
    expect(retried.tookMs).toBeUndefined();
    expect(retried.startedAt).toBe(new Date(T0 + 600_000).toISOString());
    expect(formatTaskLine(retried, T0 + 600_000)).toBe("  ◌ #1 ↻6 a 0s");
  });

  it("enforces the attempt cap on paused resumes with the exact message and no mutation", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "", maxAttempts: 1 });
    await store.update(task.id, { status: "in_progress", appendLog: "note" });
    vi.setSystemTime(T0 + 5_000);
    await store.update(task.id, { status: "paused", appendLog: "boom" });
    const before = store.get(task.id);
    const beforeDisk = await readFile(store.filePath, "utf8");
    await expect(store.update(task.id, { status: "in_progress", appendLog: "note" })).rejects.toThrow(
      "Task #1 has reached the maximum number of attempts (1).",
    );
    expect(store.get(task.id)).toEqual(before);
    expect(await readFile(store.filePath, "utf8")).toBe(beforeDisk);
  });
});

describe("paused dependencies, reset, and clear", () => {
  it("treats paused dependencies as unsatisfied and rolls back blocked mutations", async () => {
    const store = await freshStore();
    const dep = await store.create({ subject: "dep", description: "" });
    const main = await store.create({ subject: "main", description: "", blockedBy: [dep.id] });
    await store.update(dep.id, { status: "in_progress", appendLog: "note" });
    await store.update(dep.id, { status: "paused", appendLog: "dep broke" });

    const before = store.get(main.id);
    await expect(store.update(main.id, { status: "in_progress", appendLog: "note" })).rejects.toThrow(/not completed/);
    expect(store.get(main.id)).toEqual(before);

    // Reopening a dependency via rework while a dependent runs is also rejected.
    const other = await store.create({ subject: "other", description: "" });
    await store.update(other.id, { status: "in_progress", appendLog: "note" });
    await store.update(other.id, { status: "completed", appendLog: "note" });
    const runner = await store.create({ subject: "runner", description: "", blockedBy: [other.id] });
    await store.update(runner.id, { status: "in_progress", appendLog: "note" });
    await expect(store.update(other.id, { status: "in_progress", appendLog: "late rework" })).rejects.toThrow(
      /cannot remain in_progress/,
    );
    expect(store.get(other.id)?.status).toBe("completed");
    expect(store.get(runner.id)?.status).toBe("in_progress");
  });

  it("does not lazily reset a store containing paused tasks", async () => {
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress", appendLog: "note" });
    await store.update(a.id, { status: "completed", appendLog: "note" });
    await store.update(b.id, { status: "in_progress", appendLog: "note" });
    await store.update(b.id, { status: "paused", appendLog: "boom" });
    const next = await store.create({ subject: "c", description: "" });
    expect(next.id).toBe(3);
    expect(store.list().map((task) => task.subject)).toEqual(["a", "b", "c"]);
  });

  it("preserves paused tasks through clearCompleted", async () => {
    const store = await freshStore();
    const done = await store.create({ subject: "done", description: "" });
    const broken = await store.create({ subject: "broken", description: "" });
    await store.update(done.id, { status: "in_progress", appendLog: "note" });
    await store.update(done.id, { status: "completed", appendLog: "note" });
    await store.update(broken.id, { status: "in_progress", appendLog: "note" });
    await store.update(broken.id, { status: "paused", appendLog: "boom" });
    expect(await store.clearCompleted()).toEqual([done.id]);
    expect(store.list().map((task) => task.id)).toEqual([broken.id]);
    expect(store.get(broken.id)?.status).toBe("paused");
  });
});

describe("paused config compatibility", () => {
  it("defaults the paused glyph and maps legacy paused configs", async () => {
    expect(DEFAULT_CONFIG.glyphs.paused).toEqual({ character: "⏸" });
    const dir = await mkdtemp(join(tmpdir(), "pi-tasks-paused-config-"));
    dirs.push(dir);
    const messages: string[] = [];
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ glyphs: { inProgress: { character: "▶" } } }));
    const loaded = loadPiTasksConfig(path, (message) => void messages.push(message));
    expect(loaded.glyphs.paused).toEqual({ character: "⏸" });
    expect(loaded.glyphs.inProgress.character).toBe("▶");
    expect(messages).toEqual([]);
  });
});

describe("paused rendering", () => {
  it("uses the configured paused glyph", () => {
    expect(statusGlyph(widgetTask({ id: 1, subject: "a", status: "paused" }))).toBe("⏸");
    const custom = { ...DEFAULT_CONFIG, glyphs: { ...DEFAULT_CONFIG.glyphs, paused: { character: "✖" } } };
    expect(statusGlyph(widgetTask({ id: 1, subject: "a", status: "paused" }), custom)).toBe("✖");
    expect(taskRowLabel(widgetTask({ id: 2, subject: "Hi", status: "paused" }))).toBe("⏸ #2 (0/9) Hi");
  });

  it("uses the fixed warning glyph and styles paused subject like pending subject", () => {
    const assigneeConfig = { ...DEFAULT_CONFIG, enableAssignee: true };
    const lines = renderWidgetLines(
      [widgetTask({ id: 1, subject: "broke", assignee: "api", status: "paused", tookMs: 30_000 })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(lines[1]).toContain("<warning>⏸</>");
    expect(lines[1]).toContain("<text>broke</>");
    expect(lines[1]).toContain("<text>@api</>");
    expect(lines[1]).not.toContain("<dim>broke</>");
    expect(lines[1]).not.toContain("~");
    expect(lines[1]).toContain("<dim>30s</>");
    expect(formatTaskLine(widgetTask({ id: 1, subject: "broke", status: "paused", tookMs: 30_000 }), T0)).toBe(
      "  ⏸ #1 ↻9 broke 30s",
    );
  });

  it("shows N paused in the header only when pauses exist and keeps old headers otherwise", () => {
    expect(buildWidgetLines([widgetTask({ id: 1, subject: "a" })], T0)[0]).toBe("● Tasks · 1 total · 0 done");
    expect(buildWidgetLines([widgetTask({ id: 1, subject: "a", status: "completed", tookMs: 1000 })], T0)[0]).toBe(
      "● Tasks · 1 total · 1 done",
    );
    const lines = buildWidgetLines(
      [
        widgetTask({ id: 1, subject: "a", status: "completed", tookMs: 1000 }),
        widgetTask({ id: 2, subject: "b", status: "paused", tookMs: 2000 }),
        widgetTask({ id: 3, subject: "c" }),
      ],
      T0,
    );
    expect(lines[0]).toBe("● Tasks · 3 total · 1 done · 1 paused");
    const pausedHeader = renderWidgetLines([
      widgetTask({ id: 1, subject: "a", status: "completed", tookMs: 1000 }),
      widgetTask({ id: 2, subject: "b", status: "paused", tookMs: 2000 }),
      widgetTask({ id: 3, subject: "c" }),
    ], fakeTheme, undefined, true, T0)[0];
    expect(pausedHeader).toBe("<accent>● *Tasks*</><dim> · 3 total · 1 done · 1 paused</>");
    expect(pausedHeader).toContain("<accent>● *Tasks*</>");
    expect(pausedHeader).toContain("<dim> · 3 total · 1 done · 1 paused</>");
    expect(pausedHeader).toContain("*Tasks*");
    expect(pausedHeader).not.toContain("*3 total*");
    expect(pausedHeader).not.toContain("*1 done*");
    expect(pausedHeader).not.toContain("*1 paused*");
    expect(lines[2]).toContain("2s");
  });

  it("shows paused status in viewer rows and details", () => {
    const paused = widgetTask({ id: 4, subject: "broke", status: "paused", tookMs: 2000 });
    expect(taskRowLabel(paused)).toBe("⏸ #4 (0/9) broke");
    expect(buildTaskDetailLines(paused).join("\n")).toContain("paused");
  });

  it("never blinks paused glyphs", () => {
    const on = renderWidgetLines([widgetTask({ id: 1, subject: "a", status: "paused" })], fakeTheme, undefined, true);
    const off = renderWidgetLines([widgetTask({ id: 1, subject: "a", status: "paused" })], fakeTheme, undefined, false);
    expect(on[1]).toContain("<warning>⏸</>");
    expect(off[1]).toContain("<warning>⏸</>");
  });
});
