import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerExtension from "../src/index.js";
import { taskFilePath } from "../src/store.js";

const dirs: string[] = [];
let savedAgentDir: string | undefined;
let hadAgentDir = false;

beforeEach(async () => {
  hadAgentDir = "PI_CODING_AGENT_DIR" in process.env;
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-task-session-start-agent-"),
  );
  dirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  if (hadAgentDir) process.env.PI_CODING_AGENT_DIR = savedAgentDir as string;
  else delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Captured {
  tools: Map<string, any>;
  sessionStart:
    ((event: unknown, ctx: any) => Promise<void> | void) | undefined;
  turnStart: ((event: unknown, ctx: any) => Promise<void> | void) | undefined;
}

function capture(): Captured & { pi: any } {
  const captured: Captured = {
    tools: new Map(),
    sessionStart: undefined,
    turnStart: undefined,
  };
  const pi = {
    on: (event: string, handler: any) => {
      if (event === "session_start") captured.sessionStart = handler;
      if (event === "turn_start") captured.turnStart = handler;
    },
    registerTool: (tool: any) => {
      captured.tools.set(tool.name, tool);
    },
    registerCommand: (_name: string, _command: unknown) => {},
  };
  return Object.assign(captured, { pi });
}

function sessionCtx(cwd: string, sessionId: string) {
  const widgets: Array<{ key: string; content: unknown; options?: unknown }> =
    [];
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget: (key: string, content: unknown, options?: unknown) => {
        widgets.push({ key, content, options });
      },
    },
  };
  return { ctx, widgets };
}

async function freshCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-session-start-"));
  dirs.push(dir);
  return dir;
}

async function seedTask(
  cwd: string,
  sessionId: string,
  subject = "restored",
): Promise<void> {
  const { tools, pi } = capture();
  registerExtension(pi);
  const { ctx } = sessionCtx(cwd, sessionId);
  const created = await tools
    .get("task_create")
    .execute(
      "seed",
      { tasks: [{ subject, description: "" }] },
      undefined,
      undefined,
      ctx,
    );
  expect(created.isError).toBeUndefined();
}

async function seedCompletedTask(
  cwd: string,
  sessionId: string,
): Promise<void> {
  const { tools, pi } = capture();
  registerExtension(pi);
  const { ctx } = sessionCtx(cwd, sessionId);
  await tools
    .get("task_create")
    .execute(
      "seed-create",
      { tasks: [{ subject: "completed", description: "" }] },
      undefined,
      undefined,
      ctx,
    );
  await tools
    .get("task_update")
    .execute(
      "seed-start",
      { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] },
      undefined,
      undefined,
      ctx,
    );
  const updated = await tools
    .get("task_update")
    .execute(
      "seed-complete",
      { updates: [{ id: 1, status: "completed", appendLog: "done" }] },
      undefined,
      undefined,
      ctx,
    );
  expect(updated.isError).toBeUndefined();
}

describe("session_start widget restoration", () => {
  it("registers a session_start handler alongside turn_start", () => {
    const captured = capture();
    registerExtension(captured.pi);
    expect(typeof captured.sessionStart).toBe("function");
    expect(typeof captured.turnStart).toBe("function");
  });

  it.each(["startup", "reload", "resume"] as const)(
    "restores the same cwd+session store on %s",
    async (reason) => {
      const captured = capture();
      registerExtension(captured.pi);
      const cwd = await freshCwd();
      const sessionId = "restore-session";
      await seedTask(cwd, sessionId);

      const { ctx, widgets } = sessionCtx(cwd, sessionId);
      await captured.sessionStart?.({ type: "session_start", reason }, ctx);

      expect(widgets.length).toBeGreaterThan(0);
      const last = widgets[widgets.length - 1];
      expect(last.key).toBe("tasks");
      expect(typeof last.content).toBe("function");
      // Restoration reads without rewriting the persisted file.
      expect(existsSync(taskFilePath(cwd, sessionId))).toBe(true);
    },
  );

  it("restores completed history until the next turn starts, then clears it", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const cwd = await freshCwd();
    const sessionId = "completed-session";
    await seedCompletedTask(cwd, sessionId);

    const { ctx, widgets } = sessionCtx(cwd, sessionId);
    await captured.sessionStart?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    expect(typeof widgets.at(-1)?.content).toBe("function");

    await captured.turnStart?.({ type: "turn_start" }, ctx);
    expect(widgets.at(-1)).toMatchObject({ key: "tasks", content: undefined });
    const listed = await captured.tools
      .get("task_list")
      .execute("list", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)).toEqual([]);
    expect(
      JSON.parse(await readFile(taskFilePath(cwd, sessionId), "utf8")),
    ).toMatchObject({
      version: 2,
      history: [
        { tasks: [{ id: 1, subject: "completed", status: "completed" }] },
      ],
    });
  });

  it("clears the widget for an empty/new session", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const cwd = await freshCwd();

    const { ctx, widgets } = sessionCtx(cwd, "brand-new-session");
    await captured.sessionStart?.(
      { type: "session_start", reason: "new" },
      ctx,
    );

    expect(widgets.length).toBeGreaterThan(0);
    const last = widgets[widgets.length - 1];
    expect(last.key).toBe("tasks");
    expect(last.content).toBeUndefined();
    expect(existsSync(taskFilePath(cwd, "brand-new-session"))).toBe(false);
  });

  it("keeps session isolation: another session id restores nothing", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const cwd = await freshCwd();
    await seedTask(cwd, "session-a");

    const { ctx, widgets } = sessionCtx(cwd, "session-b");
    await captured.sessionStart?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    const last = widgets[widgets.length - 1];
    expect(last.key).toBe("tasks");
    expect(last.content).toBeUndefined();
    expect(existsSync(taskFilePath(cwd, "session-b"))).toBe(false);
  });

  it.each(["new", "fork"] as const)(
    "does not copy parent-session tasks into a %s session",
    async (reason) => {
      const captured = capture();
      registerExtension(captured.pi);
      const cwd = await freshCwd();
      await seedTask(cwd, "parent-session");
      const beforeDisk = await readFile(
        taskFilePath(cwd, "parent-session"),
        "utf8",
      );

      const { ctx, widgets } = sessionCtx(cwd, "child-session");
      await captured.sessionStart?.(
        {
          type: "session_start",
          reason,
          previousSessionFile: "parent-session.json",
        },
        ctx,
      );

      const last = widgets[widgets.length - 1];
      expect(last.key).toBe("tasks");
      expect(last.content).toBeUndefined();
      expect(existsSync(taskFilePath(cwd, "child-session"))).toBe(false);
      expect(await readFile(taskFilePath(cwd, "parent-session"), "utf8")).toBe(
        beforeDisk,
      );
    },
  );

  it("turn_start still refreshes the widget from the current session store", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const cwd = await freshCwd();
    const sessionId = "turn-session";
    await seedTask(cwd, sessionId);

    const { ctx, widgets } = sessionCtx(cwd, sessionId);
    await captured.turnStart?.({ type: "turn_start" }, ctx);

    expect(widgets.length).toBeGreaterThan(0);
    const last = widgets[widgets.length - 1];
    expect(last.key).toBe("tasks");
    expect(typeof last.content).toBe("function");
  });

  it("keeps one widget registration across lifecycle refreshes for the same session", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const cwd = await freshCwd();
    const sessionId = "stable-widget-session";
    await seedTask(cwd, sessionId);

    const { ctx, widgets } = sessionCtx(cwd, sessionId);
    await captured.sessionStart?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await captured.turnStart?.({ type: "turn_start" }, ctx);
    await captured.turnStart?.({ type: "turn_start" }, ctx);

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.key).toBe("tasks");
    expect(typeof widgets[0]?.content).toBe("function");
  });

  it("never throws nor resets persisted tasks when the store fails to load", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const cwd = await freshCwd();
    const sessionId = "corrupt-session";
    const path = taskFilePath(cwd, sessionId);
    await seedTask(cwd, sessionId);
    await writeFile(path, "not valid json{{{");

    const { ctx, widgets } = sessionCtx(cwd, sessionId);
    await expect(
      captured.sessionStart?.({ type: "session_start", reason: "reload" }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      captured.turnStart?.({ type: "turn_start" }, ctx),
    ).resolves.toBeUndefined();

    expect(widgets).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("not valid json{{{");
  });
});
