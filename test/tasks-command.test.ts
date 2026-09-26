import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerExtension, { tasksMenuLabels } from "../src/index.js";
import { TaskStore } from "../src/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

function capture() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const turnStart = { handler: undefined as any };
  const pi = {
    on: (event: string, handler: any) => {
      if (event === "turn_start") turnStart.handler = handler;
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: any) => {
      commands.set(name, command);
    },
  };
  registerExtension(pi as any);
  return { tools, commands, pi };
}

async function seedCtx(sessionId = "tasks-command") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-tasks-cmd-"));
  dirs.push(cwd);
  const notifications: Array<{ message: string; type: unknown }> = [];
  const widgets: Array<{ key: string; content: unknown; options: unknown }> =
    [];
  const ui: any = {
    selects: [] as Array<{ title: string; options: string[] }>,
    selectResult: undefined as string | undefined,
    select: vi.fn(async (title: string, options: string[]) => {
      ui.selects.push({ title, options });
      return ui.selectResult;
    }),
    confirm: vi.fn(async () => true),
    notify: vi.fn((message: string, type?: unknown) => {
      notifications.push({ message, type });
    }),
    custom: vi.fn(async () => {}),
    setWidget: vi.fn((key: string, content: unknown, options?: unknown) => {
      widgets.push({ key, content, options });
    }),
  };
  const ctx: any = {
    cwd,
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui,
  };
  return { cwd, ctx, ui, notifications, widgets };
}

async function seedTasks(cwd: string, sessionId: string) {
  const { tools } = capture();
  const ctx: any = {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setWidget: () => {} },
  };
  await tools
    .get("task_create")
    .execute(
      "c1",
      { tasks: [{ subject: "a", description: "" }] },
      undefined,
      undefined,
      ctx,
    );
  await tools
    .get("task_create")
    .execute(
      "c2",
      { tasks: [{ subject: "b", description: "" }] },
      undefined,
      undefined,
      ctx,
    );
  await tools
    .get("task_update")
    .execute(
      "c2b",
      { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] },
      undefined,
      undefined,
      ctx,
    );
  await tools
    .get("task_update")
    .execute(
      "c3",
      { updates: [{ id: 1, status: "completed", appendLog: "done" }] },
      undefined,
      undefined,
      ctx,
    );
}

describe("tasks command registration", () => {
  it("registers /tasks without changing the five tool contracts", () => {
    const { tools, commands } = capture();
    expect([...tools.keys()].sort()).toEqual([
      "task_create",
      "task_get",
      "task_list",
      "task_update",
    ]);
    expect([...commands.keys()]).toEqual(["tasks"]);
  });

  it("builds menu labels with live counts", () => {
    expect(tasksMenuLabels([])).toEqual([
      "View all tasks (0)",
      "Clear completed (0)",
      "Clear all (0)",
    ]);
  });
});

describe("tasks menu", () => {
  it("shows Tasks with View/Clear actions and live counts, and cancels cleanly", async () => {
    const { commands } = capture();
    const { cwd, ctx, ui } = await seedCtx();
    await seedTasks(cwd, "tasks-command");
    ui.selectResult = undefined;
    await commands.get("tasks").handler("", ctx);
    expect(ui.selects).toHaveLength(1);
    expect(ui.selects[0].title).toBe("Tasks");
    expect(ui.selects[0].options).toEqual([
      "View all tasks (2)",
      "Clear completed (1)",
      "Clear all (2)",
    ]);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("opens a centered overlay for View all tasks and guards non-terminal modes", async () => {
    const { commands } = capture();
    const { cwd, ctx, ui } = await seedCtx();
    await seedTasks(cwd, "tasks-command");
    ui.selectResult = "View all tasks (2)";
    await commands.get("tasks").handler("", ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1);
    const [factory, options] = ui.custom.mock.calls[0];
    expect(options.overlay).toBe(true);
    expect(options.overlayOptions).toBeDefined();
    // The factory builds a renderable viewer over the live tasks.
    const component = (factory as any)(
      {},
      { fg: (_c: string, text: string) => text },
      {},
      () => {},
    );
    expect(component.render(80).join("\n")).toContain("Tasks (2)");

    // Unsupported modes notify instead of opening custom UI.
    ui.custom.mockClear();
    ui.notify.mockClear();
    ctx.mode = "rpc";
    await commands.get("tasks").handler("", ctx);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(String(ui.notify.mock.calls[0][0]).toLowerCase()).toContain(
      "terminal",
    );
  });

  it("confirms Clear completed, refreshes the widget, and notifies", async () => {
    const { commands } = capture();
    const { cwd, ctx, ui, widgets } = await seedCtx();
    await seedTasks(cwd, "tasks-command");
    ui.selectResult = "Clear completed (1)";
    await commands.get("tasks").handler("", ctx);
    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith("Cleared 1 completed task(s).");
    expect(widgets.length).toBeGreaterThan(0);
    const last = widgets[widgets.length - 1];
    expect(last.key).toBe("tasks");
    expect(typeof last.content).toBe("function");
  });

  it("cancels Clear completed cleanly when confirmation is declined", async () => {
    const { commands } = capture();
    const { cwd, ctx, ui, notifications } = await seedCtx();
    await seedTasks(cwd, "tasks-command");
    ui.selectResult = "Clear completed (1)";
    ui.confirm.mockResolvedValueOnce(false);
    await commands.get("tasks").handler("", ctx);
    expect(notifications).toEqual([]);
    const { TaskStore: Store, taskFilePath } = await import("../src/store.js");
    const reloaded = await Store.load(taskFilePath(cwd, "tasks-command"));
    expect(reloaded.list()).toHaveLength(2);
  });

  it("no-ops with a notification when nothing is completed", async () => {
    const { commands } = capture();
    const { ctx, ui } = await seedCtx("no-completed");
    const { tools } = capture();
    const toolCtx: any = {
      cwd: ctx.cwd,
      sessionManager: ctx.sessionManager,
      ui: { setWidget: () => {} },
    };
    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "a", description: "" }] },
        undefined,
        undefined,
        toolCtx,
      );
    ui.selectResult = "Clear completed (0)";
    await commands.get("tasks").handler("", ctx);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledTimes(1);
  });

  it("confirms Clear all, removes the widget, and notifies", async () => {
    const { commands } = capture();
    const { cwd, ctx, ui, widgets } = await seedCtx();
    await seedTasks(cwd, "tasks-command");
    ui.selectResult = "Clear all (2)";
    await commands.get("tasks").handler("", ctx);
    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith("Cleared all 2 task(s).");
    const last = widgets[widgets.length - 1];
    expect(last.key).toBe("tasks");
    expect(last.content).toBeUndefined();
    const { TaskStore: Store, taskFilePath } = await import("../src/store.js");
    expect(
      (await Store.load(taskFilePath(cwd, "tasks-command"))).list(),
    ).toEqual([]);
  });

  it("no-ops with a notification when there are no tasks at all", async () => {
    const { commands } = capture();
    const { ctx, ui } = await seedCtx("empty");
    ui.selectResult = "Clear all (0)";
    await commands.get("tasks").handler("", ctx);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledTimes(1);
  });

  it("reports clear failures without refreshing the widget", async () => {
    const { commands } = capture();
    const { cwd, ctx, ui } = await seedCtx();
    await seedTasks(cwd, "tasks-command");
    ui.selectResult = "Clear completed (1)";
    const failure = new Error("simulated write failure");
    const spy = vi
      .spyOn(TaskStore.prototype, "clearCompleted")
      .mockRejectedValueOnce(failure);
    const widgetsBefore = ui.setWidget.mock.calls.length;
    await commands.get("tasks").handler("", ctx);
    expect(spy).toHaveBeenCalled();
    expect(ui.setWidget.mock.calls.length).toBe(widgetsBefore);
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(String(ui.notify.mock.calls[0][0])).toContain(
      "Failed to clear completed tasks",
    );
    const { taskFilePath } = await import("../src/store.js");
    expect(
      (await TaskStore.load(taskFilePath(cwd, "tasks-command"))).list(),
    ).toHaveLength(2);
  });
});
