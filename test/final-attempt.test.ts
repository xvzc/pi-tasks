import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerExtension from "../src/index.js";

const dirs: string[] = [];
let savedAgentDir: string | undefined;
let hadAgentDir = false;

beforeEach(() => {
  hadAgentDir = "PI_CODING_AGENT_DIR" in process.env;
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
  if (hadAgentDir) process.env.PI_CODING_AGENT_DIR = savedAgentDir as string;
  else delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function captureWithMaxAttempts(maxAttempts: number) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-task-final-agent-"));
  dirs.push(agentDir);
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "pi-tasks.json"), JSON.stringify({ maxAttempts }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
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
      } } };
  return { cwd, ctx, notifications };
}

describe("final-attempt warning", () => {
  it("warns exactly once when maxAttempts 1 enters in_progress with pure-JSON echo", async () => {
    const { tools, messages } = await captureWithMaxAttempts(1);
    const { ctx, notifications } = await freshCtx();
    await tools.get("task_create").execute("c1", { tasks: [{ subject: "W", description: "d" }] }, undefined, undefined, ctx);
    const params = { id: 1, status: "in_progress", appendLog: "note" };
    const updated = await tools.get("task_update").execute("c2", { updates: [params] }, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text).updated[0]).toMatchObject({ id: 1, status: "in_progress", attempt: 1, maxAttempts: 1 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].message).toBe("Task #1 is running its final attempt (1/1). No retries remain after this run.");
    expect(messages).toEqual([
      {
        message: {
          customType: "pi-tasks-final-attempt",
          content: "Task #1 is running its final attempt (1/1). No retries remain after this run.",
          display: false },
        options: { deliverAs: "steer", triggerTurn: false } },
    ]);
  });

  it("does not warn on earlier attempts, warns on the final one", async () => {
    const { tools, messages } = await captureWithMaxAttempts(2);
    const { ctx, notifications } = await freshCtx();
    await tools.get("task_create").execute("c1", { tasks: [{ subject: "W", description: "d" }] }, undefined, undefined, ctx);
    const first = await tools.get("task_update").execute("c2", { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
    expect(first.isError).toBeUndefined();
    expect(notifications).toHaveLength(0);
    expect(messages).toHaveLength(0);
    await tools.get("task_update").execute("c3", { updates: [{ id: 1, status: "paused", appendLog: "note" }] }, undefined, undefined, ctx);
    expect(notifications).toHaveLength(0);
    const second = await tools.get("task_update").execute("c4", { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
    expect(second.isError).toBeUndefined();
    expect(JSON.parse(second.content[0].text).updated[0]).toMatchObject({
      id: 1,
      status: "in_progress",
      attempt: 2,
      maxAttempts: 2 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe("Task #1 is running its final attempt (2/2). No retries remain after this run.");
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content).toBe("Task #1 is running its final attempt (2/2). No retries remain after this run.");
  });

  it("does not repeat when patching a task already in_progress on its final attempt", async () => {
    const { tools, messages } = await captureWithMaxAttempts(1);
    const { ctx, notifications } = await freshCtx();
    await tools.get("task_create").execute("c1", { tasks: [{ subject: "W", description: "d" }] }, undefined, undefined, ctx);
    await tools.get("task_update").execute("c2", { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
    expect(notifications).toHaveLength(1);
    const repeat = await tools.get("task_update").execute("c3", { updates: [{ id: 1, subject: "still running" }] }, undefined, undefined, ctx);
    expect(repeat.isError).toBeUndefined();
    expect(JSON.parse(repeat.content[0].text).updated[0]).toMatchObject({
      id: 1,
      subject: "still running",
      status: "in_progress",
      attempt: 1 });
    const restate = await tools.get("task_update").execute("c4", { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
    expect(restate.isError).toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it("preserves rejection without notifying when maxAttempts is exhausted", async () => {
    const { tools, messages } = await captureWithMaxAttempts(1);
    const { ctx, notifications } = await freshCtx();
    await tools.get("task_create").execute("c1", { tasks: [{ subject: "W", description: "d" }] }, undefined, undefined, ctx);
    await tools.get("task_update").execute("c2", { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
    await tools.get("task_update").execute("c3", { updates: [{ id: 1, status: "completed", appendLog: "note" }] }, undefined, undefined, ctx);
    expect(notifications).toHaveLength(1);
    const rejected = await tools.get("task_update").execute("c4", { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] }, undefined, undefined, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toBe("Task #1 has reached the maximum number of attempts (1).");
    expect(notifications).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it("does not convert a persisted update into an error when notification throws", async () => {
    const { tools, messages } = await captureWithMaxAttempts(1);
    const { ctx } = await freshCtx("notify-failure-session", () => {
      throw new Error("toast down");
    });
    await tools.get("task_create").execute("c1", { tasks: [{ subject: "W", description: "d" }] }, undefined, undefined, ctx);
    const params = { id: 1, status: "in_progress", appendLog: "note" };
    const updated = await tools.get("task_update").execute("c2", { updates: [params] }, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text).updated[0]).toMatchObject({ id: 1, status: "in_progress", attempt: 1, maxAttempts: 1 });
    const stored = JSON.parse((await tools.get("task_get").execute("c3", { id: 1 }, undefined, undefined, ctx)).content[0].text);
    expect(stored).toMatchObject({ id: 1, status: "in_progress", attempt: 1, maxAttempts: 1 });
    expect(messages).toHaveLength(1);
  });
});

describe("batch final-attempt warnings", () => {
  it("notifies once for every task entering its final attempt after a successful batch commit", async () => {
    const { tools, messages } = await captureWithMaxAttempts(1);
    const { ctx, notifications } = await freshCtx("batch-final-attempt");
    await tools.get("task_create").execute(
      "create",
      {
        tasks: [
          { subject: "A", description: "" },
          { subject: "B", description: "" },
        ] },
      undefined,
      undefined,
      ctx,
    );
    const result = await tools.get("task_update").execute(
      "update",
      { updates: [{ id: 2, status: "in_progress", appendLog: "note" }, { id: 1, status: "in_progress", appendLog: "note" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(notifications.map((entry) => entry.message)).toEqual([
      "Task #1 is running its final attempt (1/1). No retries remain after this run.",
      "Task #2 is running its final attempt (1/1). No retries remain after this run.",
    ]);
    expect(messages.map((entry) => entry.message.content)).toEqual(notifications.map((entry) => entry.message));
  });

  it("emits no warnings when any patch makes the batch fail", async () => {
    const { tools, messages } = await captureWithMaxAttempts(1);
    const { ctx, notifications } = await freshCtx("paused-batch-final-attempt");
    await tools.get("task_create").execute(
      "create",
      { tasks: [{ subject: "A", description: "" }, { subject: "B", description: "" }] },
      undefined,
      undefined,
      ctx,
    );
    const result = await tools.get("task_update").execute(
      "update",
      { updates: [{ id: 1, status: "in_progress", appendLog: "note" }, { id: 2, subject: "   " }] },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(notifications).toEqual([]);
    expect(messages).toEqual([]);
  });
});
