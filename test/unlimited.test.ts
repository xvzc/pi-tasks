import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerExtension from "../src/index.js";
import { DEFAULT_CONFIG, loadPiTasksConfig, type PiTasksConfig } from "../src/config.js";
import { TaskStore } from "../src/store.js";
import { buildTaskDetailLines, taskRowLabel } from "../src/tasks-ui.js";
import {
  buildWidgetLines,
  formatTaskLine,
  renderWidgetLines,
  statusGlyph,
  type ThemeLike } from "../src/widget.js";
import type { Task } from "../src/types.js";

const dirs: string[] = [];
let savedEnv: string | undefined;
let hadEnv = false;

beforeEach(() => {
  hadEnv = "PI_CODING_AGENT_DIR" in process.env;
  savedEnv = process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
  if (hadEnv) process.env.PI_CODING_AGENT_DIR = savedEnv as string;
  else delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function task(overrides: Partial<Task> & { id: number; subject: string }): Task {
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

const customConfig: PiTasksConfig = {
  maxAttempts: 9,
  enableAssignee: true,
  glyphs: {
    inProgress: { character: "▶", frames: ["⠁", "⠂", "⠄", "⡀", "⠄", "⠂"] },
    pending: { character: "○", retriedCharacter: "■" },
    completed: { character: "✔", awaitingReviewCharacter: "○" },
    paused: { character: "✖" },
    deleted: { character: "⏸" } } };

async function freshStore(): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-unlimited-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

describe("unlimited tasks in the store", () => {
  it("creates unlimited tasks when the configured default is 0", async () => {
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" }, 0);
    expect(created).toMatchObject({ attempt: 0, maxAttempts: 0 });
    expect(store.get(created.id)).toMatchObject({ attempt: 0, maxAttempts: 0 });
  });

  it("increments attempts on unlimited tasks without ever exhausting", async () => {
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" }, 0);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await store.update(created.id, { status: "in_progress", appendLog: "note" });
      expect(store.get(created.id)).toMatchObject({ attempt, maxAttempts: 0, status: "in_progress" });
      await store.update(created.id, { status: "in_progress", appendLog: "note" });
    await store.update(created.id, { status: "completed", appendLog: "note" });
    }
    await store.update(created.id, { status: "in_progress", appendLog: "note" });
    expect(store.get(created.id)).toMatchObject({ attempt: 4, maxAttempts: 0 });
  });

  it("still rejects an explicit maxAttempts of 0 on create", async () => {
    const store = await freshStore();
    await expect(store.create({ subject: "a", description: "", maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
    expect(store.list()).toEqual([]);
  });

  it("round-trips unlimited tasks through the persisted envelope", async () => {
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" }, 0);
    await store.update(created.id, { status: "in_progress", appendLog: "note" });
    expect((await TaskStore.load(store.filePath)).get(created.id)).toMatchObject({ attempt: 1, maxAttempts: 0 });
  });

  it("derives the paused warning color from the persisted attempt after reload", async () => {
    const store = await freshStore();
    const created = await store.create({ subject: "retry", description: "" });
    await store.update(created.id, { status: "in_progress", appendLog: "note" });
    await store.update(created.id, { status: "paused", appendLog: "note" });
    const reloaded = await TaskStore.load(store.filePath);
    const lines = renderWidgetLines(reloaded.list(), fakeTheme);
    expect(lines[1]).toMatch(/^  <warning>⏸<\/\>/);
  });
});

describe("unlimited counter rendering", () => {
  it("renders the remaining-attempts indicator in plain widget lines", () => {
    expect(formatTaskLine(task({ id: 1, subject: "Free" }), Date.now())).toContain("#1 ↻9");
    expect(formatTaskLine(task({ id: 1, subject: "Free", maxAttempts: 0 }))).toBe("  ◌ #1 Free");
    expect(formatTaskLine(task({ id: 1, subject: "Free", assignee: "api", maxAttempts: 0 }), Date.now(), { ...DEFAULT_CONFIG, enableAssignee: true })).toBe(
      "  ◌ #1 @api Free",
    );
    expect(buildWidgetLines([task({ id: 1, subject: "Free", maxAttempts: 0 })])[1]).toBe("  ◌ #1 Free");
  });

  it("hides the counter in themed widget lines while keeping glyph/subject styles", () => {
    const lines = renderWidgetLines(
      [task({ id: 1, subject: "Free", status: "in_progress", attempt: 3, maxAttempts: 0 })],
      fakeTheme,
    );
    expect(lines[1]).toContain("<dim>#1</>");
    expect(lines[1]).not.toContain("(3/0)");
    expect(lines[1]).not.toContain("(");
  });

  it("hides the counter in /tasks rows and detail lines", () => {
    expect(taskRowLabel(task({ id: 2, subject: "Free", maxAttempts: 0 }))).toBe("◌ #2 Free");
    expect(taskRowLabel(task({ id: 2, subject: "Free", blockedBy: [1], maxAttempts: 0 }))).toBe(
      "◌ #2 Free → (1)",
    );
    const detail = buildTaskDetailLines(task({ id: 2, subject: "Free", attempt: 3, maxAttempts: 0 }));
    expect(detail).toContain("Task: #2");
    expect(detail.join("\n")).not.toContain("(3/0)");
    // Limited tasks keep the counter everywhere.
    expect(taskRowLabel(task({ id: 2, subject: "Capped" }))).toBe("◌ #2 (0/9) Capped");
    expect(buildTaskDetailLines(task({ id: 2, subject: "Capped" }))).toContain("Task: #2 (0/9)");
  });
});

describe("configurable glyph characters", () => {
  it("uses the configured glyph character per status", () => {
    expect(statusGlyph(task({ id: 1, subject: "a", status: "pending" }), customConfig)).toBe("○");
    expect(statusGlyph(task({ id: 1, subject: "a", status: "in_progress" }), customConfig)).toBe("⠁");
    expect(statusGlyph(task({ id: 1, subject: "a", status: "completed" }), customConfig)).toBe("✔");
    expect(statusGlyph(task({ id: 1, subject: "a" }))).toBe("◌");
    expect(formatTaskLine(task({ id: 1, subject: "a" }), Date.now(), customConfig)).toBe("  ○ #1 ↻9 a");
    expect(taskRowLabel(task({ id: 1, subject: "a" }), customConfig)).toBe("○ #1 (0/9) a");
  });

  it("keeps fixed status colors with configured glyph characters", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "a" })], fakeTheme, undefined, true, Date.now(), undefined, customConfig);
    expect(pending[1]).toMatch(/^  <dim>○<\/>/);
    const retried = renderWidgetLines([task({ id: 1, subject: "a", attempt: 1 })], fakeTheme, undefined, true, Date.now(), undefined, customConfig);
    expect(retried[1]).toMatch(/^  <warning>■<\/>/);
    const active = renderWidgetLines(
      [task({ id: 2, subject: "b", status: "in_progress" })],
      fakeTheme,
      undefined,
      true,
      Date.now(),
      undefined,
      customConfig,
    );
    expect(active[1]).toMatch(/^  <success>⠁<\/>/);
    const done = renderWidgetLines(
      [task({ id: 3, subject: "c", status: "completed" })],
      fakeTheme,
      undefined,
      true,
      Date.now(),
      undefined,
      customConfig,
    );
    expect(done[1]).toMatch(/^  <success>✔<\/>/);
  });

  it("blanks the glyph's visible width for character-only legacy config, including the default character", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-task-legacy-glyph-"));
    dirs.push(dir);
    for (const [name, character] of [["wide", ">>"], ["default", "⠁"]] as const) {
      const path = join(dir, `${name}.json`);
      await writeFile(path, JSON.stringify({ glyphs: { inProgress: { character } } }));
      const config = loadPiTasksConfig(path, () => {});
      const spread: PiTasksConfig = {
        ...config,
        glyphs: {
          ...config.glyphs,
          inProgress: { ...config.glyphs.inProgress, frames: [...config.glyphs.inProgress.frames] } } };
      const roundTripped = JSON.parse(JSON.stringify(config)) as PiTasksConfig;
      const active = [task({ id: 1, subject: "a", status: "in_progress" })];
      for (const normalized of [config, spread, roundTripped]) {
        const on = renderWidgetLines(active, fakeTheme, undefined, 0, Date.now(), undefined, normalized);
        const off = renderWidgetLines(active, fakeTheme, undefined, 1, Date.now(), undefined, normalized);
        expect(on[1]).toContain(`<success>${character}</>`);
        expect(off[1]).toContain(`<success>${" ".repeat(visibleWidth(character))}</>`);
        expect(visibleWidth(off[1])).toBe(visibleWidth(on[1]));
      }
    }
  });
});

describe("unlimited tasks via tools", () => {
  function capture() {
    const tools = new Map<string, any>();
    const messages: Array<{ message: any; options: any }> = [];
    const pi = {
      on: () => {},
      registerTool: (tool: any) => {
        tools.set(tool.name, tool);
      },
      registerCommand: (_name: string, _command: unknown) => {},
      sendMessage: (message: any, options: any) => {
        messages.push({ message, options });
      } };
    registerExtension(pi as any);
    return { tools, messages };
  }

  async function unlimitedCtx(sessionId: string) {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-task-agent-"));
    dirs.push(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tasks.json"), JSON.stringify({ maxAttempts: 0 }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = await mkdtemp(join(tmpdir(), "pi-task-unlimited-tool-"));
    dirs.push(cwd);
    const notifications: Array<{ message: string; level: unknown }> = [];
    const ctx: any = {
      cwd,
      sessionManager: { getSessionId: () => sessionId },
      ui: {
        setWidget: () => {},
        notify: (message: string, level: unknown) => {
          notifications.push({ message, level });
        } } };
    return { ctx, notifications };
  }

  it("uses the configured maxAttempts 0 and keeps JSON payload fields", async () => {
    const { ctx } = await unlimitedCtx("unlimited-tool-session");
    const { tools } = capture();
    const created = await tools.get("task_create").execute("c1", { tasks: [{ subject: "W", description: "d" }] }, undefined, undefined, ctx);
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text).tasks[0]).toMatchObject({ id: 1, attempt: 0, maxAttempts: 0 });
    const gotten = await tools.get("task_get").execute("c2", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({ attempt: 0, maxAttempts: 0 });
    const listed = await tools.get("task_list").execute("c3", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)[0]).toMatchObject({ attempt: 0, maxAttempts: 0 });
  });

  it("never warns or exhausts unlimited tasks across repeated attempts", async () => {
    const { ctx, notifications } = await unlimitedCtx("unlimited-final-session");
    const { tools, messages } = capture();
    await tools.get("task_create").execute("c1", { tasks: [{ subject: "W", description: "d" }] }, undefined, undefined, ctx);
    for (let n = 2; n <= 5; n += 1) {
      const updated = await tools.get("task_update").execute(`c${n}`, { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
      expect(updated.isError).toBeUndefined();
      await tools.get("task_update").execute(`d${n}`, { updates: [{ id: 1, status: "completed", appendLog: "note" }] }, undefined, undefined, ctx);
    }
    await tools.get("task_update").execute("c6", { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
    const stored = JSON.parse((await tools.get("task_get").execute("c7", { id: 1 }, undefined, undefined, ctx)).content[0].text);
    expect(stored).toMatchObject({ attempt: 5, maxAttempts: 0, status: "in_progress" });
    expect(notifications).toEqual([]);
    expect(messages).toEqual([]);
  });
});
