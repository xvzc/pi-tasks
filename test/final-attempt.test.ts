import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import registerExtension from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
    },
  };
  registerExtension(pi as any);
  return { tools, messages };
}

async function freshCtx(sessionId = "final-attempt-session", notify?: (...args: any[]) => unknown) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-task-final-"));
  dirs.push(cwd);
  const notifications: Array<{ message: string; level: unknown }> = [];
  const ctx: any = {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget: () => {},
      notify: (message: string, level: unknown) => {
        if (notify) return notify(message, level);
        notifications.push({ message, level });
      },
    },
  };
  return { cwd, ctx, notifications };
}

describe("final-attempt warning", () => {
  it("warns exactly once when maxAttempts 1 enters in_progress with pure-JSON echo", async () => {
    const { tools, messages } = capture();
    const { ctx, notifications } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d", maxAttempts: 1 }, undefined, undefined, ctx);
    const params = { id: 1, status: "in_progress" };
    const updated = await tools.get("TaskUpdate").execute("c2", params, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text)).toEqual(params);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].message).toBe("Task #1 is running its final attempt (1/1). No retries remain after this run.");
    expect(messages).toEqual([
      {
        message: {
          customType: "pi-tasks-final-attempt",
          content: "Task #1 is running its final attempt (1/1). No retries remain after this run.",
          display: false,
        },
        options: { deliverAs: "steer", triggerTurn: false },
      },
    ]);
  });

  it("does not warn on earlier attempts, warns on the final one", async () => {
    const { tools, messages } = capture();
    const { ctx, notifications } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d", maxAttempts: 2 }, undefined, undefined, ctx);
    const first = await tools.get("TaskUpdate").execute("c2", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    expect(first.isError).toBeUndefined();
    expect(notifications).toHaveLength(0);
    expect(messages).toHaveLength(0);
    await tools.get("TaskUpdate").execute("c3", { id: 1, status: "pending" }, undefined, undefined, ctx);
    expect(notifications).toHaveLength(0);
    const second = await tools.get("TaskUpdate").execute("c4", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    expect(second.isError).toBeUndefined();
    expect(JSON.parse(second.content[0].text)).toEqual({ id: 1, status: "in_progress" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe("Task #1 is running its final attempt (2/2). No retries remain after this run.");
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content).toBe("Task #1 is running its final attempt (2/2). No retries remain after this run.");
  });

  it("does not repeat when patching a task already in_progress on its final attempt", async () => {
    const { tools, messages } = capture();
    const { ctx, notifications } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d", maxAttempts: 1 }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c2", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    expect(notifications).toHaveLength(1);
    const repeat = await tools.get("TaskUpdate").execute("c3", { id: 1, subject: "still running" }, undefined, undefined, ctx);
    expect(repeat.isError).toBeUndefined();
    expect(JSON.parse(repeat.content[0].text)).toEqual({ id: 1, subject: "still running" });
    const restate = await tools.get("TaskUpdate").execute("c4", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    expect(restate.isError).toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it("preserves rejection without notifying when maxAttempts is exhausted", async () => {
    const { tools, messages } = capture();
    const { ctx, notifications } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d", maxAttempts: 1 }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c2", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c3", { id: 1, status: "completed" }, undefined, undefined, ctx);
    expect(notifications).toHaveLength(1);
    const rejected = await tools.get("TaskUpdate").execute("c4", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toBe("Task #1 has reached the maximum number of attempts (1).");
    expect(notifications).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it("does not convert a persisted update into an error when notification throws", async () => {
    const { tools, messages } = capture();
    const { ctx } = await freshCtx("notify-failure-session", () => {
      throw new Error("toast down");
    });
    await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d", maxAttempts: 1 }, undefined, undefined, ctx);
    const params = { id: 1, status: "in_progress" };
    const updated = await tools.get("TaskUpdate").execute("c2", params, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text)).toEqual(params);
    const stored = JSON.parse((await tools.get("TaskGet").execute("c3", { id: 1 }, undefined, undefined, ctx)).content[0].text);
    expect(stored).toMatchObject({ id: 1, status: "in_progress", attempt: 1, maxAttempts: 1 });
    expect(messages).toHaveLength(1);
  });
});
