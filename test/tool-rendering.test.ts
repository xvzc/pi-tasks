import { afterEach, describe, expect, it, vi } from "vitest";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import registerExtension from "../src/index.js";
import { DEFAULT_CONFIG, type PiTasksConfig } from "../src/config.js";
import {
  renderTaskCall,
  renderTaskCreate,
  renderTaskGet,
  renderTaskList,
  renderTaskResult,
  renderTaskToolError,
  renderTaskUpdate,
  sanitizeText,
  semanticDiff,
} from "../src/tool-rendering.js";
import type { Task } from "../src/types.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    subject: "Implement renderer",
    description: "Show useful task details",
    status: "pending",
    attempt: 0,
    maxAttempts: 8,
    blockedBy: [],
    reviewOf: [],
    metadata: {},
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("task rendering formatters", () => {
  const assigneeConfig: PiTasksConfig = { ...DEFAULT_CONFIG, enableAssignee: true };
  it("renders create singular/plural summaries and ID/title rows", () => {
    expect(renderTaskCreate([task()])).toEqual({
      collapsed: "✓ Created 1 task",
      expanded: "✓ Created 1 task\n  ◌ #1 Implement renderer",
    });
    const many = renderTaskCreate([task(), task({ id: 2, subject: "Verify renderer" })]);
    expect(many.collapsed).toBe("✓ Created 2 tasks");
    expect(many.expanded).toContain("\n  ◌ #2 Verify renderer");
    expect(many.expanded).not.toContain("task(s)");
  });

  it("renders semantic update diffs in fixed order and excludes derived fields", () => {
    const before = task({ assignee: "old", blockedBy: [2], metadata: { z: 1, same: true } });
    const after = task({
      subject: "Final subject",
      description: "New description",
      assignee: "new",
      status: "completed",
      blockedBy: [3],
      metadata: { z: 2, same: true },
      log: [{ timestamp: "2026-01-02T00:00:00.000Z", message: "done" }],
      attempt: 7,
      updatedAt: "2026-01-02T00:00:00.000Z",
      tookMs: 100,
    });
    expect(semanticDiff(before, after)).toEqual([
      "status",
      "subject",
      "description",
      "assignee",
      "dependencies",
      "metadata",
      "log",
    ]);
    expect(renderTaskUpdate([{ before, after }], assigneeConfig)).toEqual({
      collapsed: "✓ Updated 1 task",
      expanded: "✓ Updated 1 task\n  ● #1 Final subject → status, subject, description, assignee, dependencies, metadata, log",
    });

    const derivedOnly = task({ attempt: 1, updatedAt: "later", startedAt: "now" });
    expect(renderTaskUpdate([{ before: task(), after: derivedOnly }]).expanded).toBe(
      "✓ Updated 1 task\n  ■ #1 Implement renderer → no changes",
    );
  });

  it("renders the get operational view with bounded latest logs and placeholders", () => {
    const view = renderTaskGet(task({
      maxAttempts: 0,
      log: ["one", "two", "three", "four"].map((message, index) => ({ timestamp: String(index), message })),
      metadata: { secret: "not displayed" },
    }), [task()], assigneeConfig);
    expect(view.collapsed).toBe("✓ Retrieved task #1");
    expect(view.expanded).toBe([
      "✓ Retrieved task #1",
      "  ◌ #1 Implement renderer",
      "  Status: pending",
      "  Description: Show useful task details",
      "  Assignee: —",
      "  Dependencies: —",
      "  Attempts: 0/unlimited",
      "  Recent log:",
      "  - two",
      "  - three",
      "  - four",
    ].join("\n"));
    expect(view.expanded).not.toContain("one");
    expect(view.expanded).not.toContain("metadata");
    expect(view.expanded).not.toContain("timestamp");
    expect(renderTaskGet(task(), [task()], assigneeConfig).expanded).toContain("  Attempts: 0/8\n  Recent log: —");
  });

  it("renders filtered, ordered, and empty lists", () => {
    const tasks = [task({ id: 2, subject: "Second", status: "completed" }), task({ id: 1, subject: "First" })];
    expect(renderTaskList(tasks, "completed")).toEqual({
      collapsed: "✓ Listed 2 tasks · status: completed",
      expanded: "✓ Listed 2 tasks · status: completed\n  ● #2 Second → completed\n  ◌ #1 First → pending",
    });
    expect(renderTaskList([], "paused")).toEqual({
      collapsed: "○ No tasks · status: paused",
      expanded: "○ No tasks · status: paused",
    });
  });

  it("uses exact operation errors, sanitizes expected detail, and masks unexpected detail", () => {
    expect(renderTaskToolError("create", "bad\ninput\u001b[31m", undefined, true).collapsed).toBe("✗ Failed to create tasks");
    expect(renderTaskToolError("update", "bad", undefined, true).collapsed).toBe("✗ Failed to update tasks");
    expect(renderTaskToolError("get", "bad", 9, true).collapsed).toBe("✗ Failed to retrieve task #9");
    expect(renderTaskToolError("list", "bad", undefined, true).collapsed).toBe("✗ Failed to list tasks");
    const expected = renderTaskToolError("get", "bad\ninput\u001b[31m", 9, true);
    expect(expected.expanded).toBe("✗ Failed to retrieve task #9\n  bad input");
    const unexpected = renderTaskToolError("list", new Error("internal secret"));
    expect(unexpected.expanded).toBe("✗ Failed to list tasks\n  Unexpected internal error.");
    expect(unexpected.expanded).not.toContain("secret");
  });

  it("neutralizes controls and keeps every rendered line width bounded", () => {
    expect(sanitizeText("a\n\tb\u001b[31mred\u001b[0m")).toBe("a bred");
    const rendered = renderTaskCreate([task({ subject: `unsafe\n\u001b[31m${"界".repeat(100)}` })]).expanded;
    expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(rendered.split("\n").every((line) => visibleWidth(line) <= 120)).toBe(true);
  });

  it("renders safely at narrow host widths and preserves update change fields", () => {
    const before = task();
    const after = task({
      subject: "A very long final subject that should yield space to the semantic change suffix",
      status: "completed",
      description: "changed",
      assignee: "reviewer",
      blockedBy: [2], });
    const rendering = renderTaskUpdate([{ before, after }], assigneeConfig);
    expect(rendering.expanded).toMatch(/→ status, subject, description, assignee, dependencies$/);
    expect(rendering.expanded).not.toContain("A very long final subject that should yield space to the semantic change suffix →");

    const lines = renderTaskResult(
      { content: [{ type: "text", text: "model text" }], details: { rendering } },
      true,
      false,
    ).render(24);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(lines.join("\n")).toContain("dependencies");

    const themedLines = renderTaskResult(
      { content: [{ type: "text", text: "model text" }], details: { rendering } },
      true,
      false,
      "update",
      undefined,
      { fg: (_color, text) => `\u001b[31m${text}\u001b[0m` },
    ).render(24);
    expect(themedLines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("themes settled summaries and every expanded detail line", () => {
    const calls: Array<[string, string]> = [];
    const theme = { fg: (color: string, text: string) => { calls.push([color, text]); return text; } } as any;
    const rendering = renderTaskCreate([task(), task({ id: 2, subject: "Verify renderer" })]);
    const rendered = renderTaskResult(
      { content: [{ type: "text", text: "model text" }], details: { rendering } },
      true,
      false,
      "create",
      undefined,
      theme,
    ).render(200).map((line) => line.trimEnd()).join("\n");

    expect(rendered).toBe(rendering.expanded);
    expect(calls).toEqual([
      ["success", "✓"],
      ["toolTitle", "Created 2 tasks"],
      ["toolOutput", "  ◌ #1 Implement renderer"],
      ["toolOutput", "  ◌ #2 Verify renderer"],
    ]);

    calls.length = 0;
    const failure = renderTaskToolError("get", "missing", 4, true);
    expect(renderTaskResult(
      { content: [{ type: "text", text: "missing" }], details: { rendering: failure } },
      true,
      true,
      "get",
      4,
      theme,
    ).render(200).map((line) => line.trimEnd()).join("\n")).toBe(failure.expanded);
    expect(calls).toEqual([
      ["error", "✗"],
      ["error", "Failed to retrieve task #4"],
      ["toolOutput", "  missing"],
    ]);

    calls.length = 0;
    const empty = renderTaskList([]);
    expect(renderTaskResult(
      { content: [{ type: "text", text: "[]" }], details: { rendering: empty } },
      false,
      false,
      "list",
      undefined,
      theme,
    ).render(200).join("\n").trimEnd()).toBe(empty.collapsed);
    expect(calls).toEqual([["dim", "○"], ["toolTitle", "No tasks"]]);
  });

  it("preserves plain output when theming is unavailable or throws", () => {
    const rendering = renderTaskCreate([task()]);
    const result = { content: [{ type: "text", text: "model text" }], details: { rendering } };
    expect(renderTaskResult(result, true, false).render(200).map((line) => line.trimEnd()).join("\n")).toBe(rendering.expanded);
    expect(renderTaskResult(
      result,
      true,
      false,
      "create",
      undefined,
      { fg: () => { throw new Error("theme failed"); } },
    ).render(200).map((line) => line.trimEnd()).join("\n")).toBe(rendering.expanded);
  });

  it("advances one reused spinner through context.invalidate and stops without leaks", () => {
    vi.useFakeTimers();
    const invalidate = vi.fn();
    const state: any = {};
    const context: any = { toolCallId: "create-1", executionStarted: false, isPartial: true, invalidate, state };
    const first = renderTaskCall("Creating tasks…", context);
    const firstFrame = first.render(200).join("\n").trimEnd();
    expect(firstFrame).toMatch(/^⠋ Creating tasks…$/);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(80);
    expect(first.render(200).join("\n").trimEnd()).toMatch(/^⠙ Creating tasks…$/);
    expect(invalidate).toHaveBeenCalledTimes(1);

    context.lastComponent = first;
    context.executionStarted = true;
    const reused = renderTaskCall("Creating tasks…", context);
    expect(reused).toBe(first);
    expect(state.taskCallSpinner).toBe(first);
    expect(vi.getTimerCount()).toBe(1);

    context.isPartial = false;
    const settled = renderTaskCall("Creating tasks…", context);
    expect(settled).not.toBe(first);
    expect(settled.render(200)).toEqual([]);
    expect(state.taskCallSpinner).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(160);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("animates from pre-execution pending and lets settled renderResult stop shared state", () => {
    vi.useFakeTimers();
    const initialInvalidate = vi.fn();
    const initial = renderTaskCall("Listing tasks…", {
      toolCallId: "not-started",
      executionStarted: false,
      isPartial: true,
      invalidate: initialInvalidate,
      state: {},
    });
    expect(initial.render(200).join("\n").trimEnd()).toBe("⠋ Listing tasks…");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(80);
    expect(initial.render(200).join("\n").trimEnd()).toBe("⠙ Listing tasks…");
    expect(initialInvalidate).toHaveBeenCalledTimes(1);
    expect(renderTaskCall("Listing tasks…", {
      toolCallId: "not-started",
      executionStarted: true,
      isPartial: false,
    }).render(200)).toEqual([]);
    expect(renderTaskCall("Listing tasks…", {
      toolCallId: "settled",
      executionStarted: true,
      isPartial: false,
      state: {},
    }).render(200)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    const state: any = {};
    const running = renderTaskCall("Listing tasks…", { toolCallId: "list-1", executionStarted: false, isPartial: true, invalidate: vi.fn(), state });
    expect(vi.getTimerCount()).toBe(1);
    renderTaskResult(
      { content: [{ type: "text", text: "[]" }], details: { rendering: renderTaskList([]) } },
      false,
      false,
      "list",
      undefined,
      undefined,
      { toolCallId: "list-1", isPartial: false, state },
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(state.taskCallSpinner).toBeUndefined();
    const afterSuccess = renderTaskCall("Listing tasks…", {
      toolCallId: "list-1",
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      state: {},
    });
    expect(afterSuccess).not.toBe(running);
    renderTaskCall("Listing tasks…", { toolCallId: "list-1", executionStarted: true, isPartial: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers an active spinner by toolCallId after state and component loss", () => {
    vi.useFakeTimers();
    const firstState: any = {};
    const first = renderTaskCall("Updating tasks…", {
      toolCallId: "recover-1",
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      state: firstState,
    });
    expect(vi.getTimerCount()).toBe(1);

    const replacementState: any = {};
    const recovered = renderTaskCall("Updating tasks…", {
      toolCallId: "recover-1",
      executionStarted: true,
      isPartial: true,
      invalidate: vi.fn(),
      state: replacementState,
    });
    expect(recovered).toBe(first);
    expect(replacementState.taskCallSpinner).toBe(first);
    expect(vi.getTimerCount()).toBe(1);

    const recoveredWithoutState = renderTaskCall("Updating tasks…", {
      toolCallId: "recover-1",
      executionStarted: true,
      isPartial: true,
      invalidate: vi.fn(),
    });
    expect(recoveredWithoutState).toBe(first);
    expect(vi.getTimerCount()).toBe(1);

    renderTaskCall("Updating tasks…", { toolCallId: "recover-1", executionStarted: true, isPartial: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(firstState.taskCallSpinner).toBeUndefined();
    expect(replacementState.taskCallSpinner).toBeUndefined();
    const afterCleanup = renderTaskCall("Updating tasks…", {
      toolCallId: "recover-1",
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      state: {},
    });
    expect(afterCleanup).not.toBe(first);
    renderTaskCall("Updating tasks…", { toolCallId: "recover-1", executionStarted: true, isPartial: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a stale spinner when lastComponent is replaced", () => {
    vi.useFakeTimers();
    const state: any = {};
    const first = renderTaskCall("Updating tasks…", {
      toolCallId: "replace-1",
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      state,
    });
    const replacement = renderTaskCall("Updating tasks…", {
      toolCallId: "replace-1",
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      lastComponent: new Text("replacement", 0, 0),
      state,
    });
    expect(replacement).not.toBe(first);
    expect(state.taskCallSpinner).toBe(replacement);
    expect(vi.getTimerCount()).toBe(1);

    renderTaskResult(
      { content: [{ type: "text", text: "paused" }], details: undefined },
      false,
      true,
      "update",
      1,
      undefined,
      { toolCallId: "replace-1", isPartial: false, state: {} },
    );
    expect(vi.getTimerCount()).toBe(0);
    const afterCleanup = renderTaskCall("Updating tasks…", {
      toolCallId: "replace-1",
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      state: {},
    });
    expect(afterCleanup).not.toBe(replacement);
    renderTaskCall("Updating tasks…", { toolCallId: "replace-1", executionStarted: true, isPartial: false });
  });

  it("does not animate without a stable toolCallId and stops when invalidate throws", () => {
    vi.useFakeTimers();
    const state: any = {};
    const fallback = renderTaskCall("Retrieving task…", {
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      state,
    });
    expect(fallback.render(200).join("\n").trimEnd()).toBe("Retrieving task…");
    expect(state.taskCallSpinner).toBeUndefined();
    expect(renderTaskCall("Retrieving task…").render(200).join("\n").trimEnd()).toBe("Retrieving task…");
    expect(vi.getTimerCount()).toBe(0);

    const throwingState: any = {};
    const throwing = renderTaskCall("Retrieving task…", {
      toolCallId: "throw-1",
      executionStarted: false,
      isPartial: true,
      invalidate: () => { throw new Error("render unavailable"); },
      state: throwingState,
    });
    expect(vi.getTimerCount()).toBe(1);
    expect(() => vi.advanceTimersByTime(80)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(throwingState.taskCallSpinner).toBeUndefined();

    const afterFailure = renderTaskCall("Retrieving task…", {
      toolCallId: "throw-1",
      executionStarted: true,
      isPartial: true,
      invalidate: vi.fn(),
      state: {},
    });
    expect(afterFailure).not.toBe(throwing);
    expect(afterFailure.render(200)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    const restarted = renderTaskCall("Retrieving task…", {
      toolCallId: "throw-1",
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
      state: {},
    });
    expect(restarted).not.toBe(throwing);
    expect(vi.getTimerCount()).toBe(1);
    renderTaskCall("Retrieving task…", { toolCallId: "throw-1", executionStarted: true, isPartial: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("registered tool renderers", () => {
  it("registers exact count-free renderCall labels for complete and partial args", () => {
    const tools = new Map<string, any>();
    registerExtension({
      on() {},
      registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    } as any);
    const text = (name: string, args: unknown) => tools.get(name).renderCall(args, {}, {}).render(200).join("\n").trimEnd();
    expect(text("task_create", { tasks: [{}, {}] })).toBe("Creating tasks…");
    expect(text("task_update", { updates: [{}, {}] })).toBe("Updating tasks…");
    expect(text("task_get", { id: 3 })).toBe("Retrieving task…");
    expect(text("task_list", { status: "paused" })).toBe("Listing tasks…");

    expect(text("task_create", undefined)).toBe("Creating tasks…");
    expect(text("task_update", {})).toBe("Updating tasks…");
    expect(text("task_get", undefined)).toBe("Retrieving task…");
    expect(text("task_list", undefined)).toBe("Listing tasks…");
    for (const tool of tools.values()) expect(tool.renderShell).toBeUndefined();
  });

  it("uses the host render context to animate all four labels without argument detail", () => {
    vi.useFakeTimers();
    const tools = new Map<string, any>();
    registerExtension({ on() {}, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
    const cases = [
      ["task_create", { tasks: [{}, {}] }, "Creating tasks…"],
      ["task_update", { updates: [{}, {}] }, "Updating tasks…"],
      ["task_get", { id: 99 }, "Retrieving task…"],
      ["task_list", { status: "paused" }, "Listing tasks…"],
    ] as const;

    for (const [name, args, label] of cases) {
      const context: any = {
        args,
        toolCallId: name,
        executionStarted: false,
        isPartial: true,
        invalidate: vi.fn(),
        lastComponent: undefined,
        state: {},
      };
      const component = tools.get(name).renderCall(args, {}, context);
      expect(component.render(200).join("\n").trimEnd()).toBe(`⠋ ${label}`);
      vi.advanceTimersByTime(80);
      expect(component.render(200).join("\n").trimEnd()).toBe(`⠙ ${label}`);
      expect(context.invalidate).toHaveBeenCalledTimes(1);
      context.lastComponent = component;
      context.isPartial = false;
      const settledCall = tools.get(name).renderCall(args, {}, context);
      expect(settledCall.render(200)).toEqual([]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("host call-plus-result composition replaces loading text for all four tools", () => {
    vi.useFakeTimers();
    initTheme(undefined, false);
    const tools = new Map<string, any>();
    registerExtension({ on() {}, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
    const cases = [
      ["task_create", "Creating tasks…", renderTaskCreate([task()])],
      ["task_update", "Updating tasks…", renderTaskUpdate([{ before: task(), after: task({ status: "completed" }) }])],
      ["task_get", "Retrieving task…", renderTaskGet(task())],
      ["task_list", "Listing tasks…", renderTaskList([task()])],
    ] as const;
    for (const [name, loadingLabel, rendering] of cases) {
      const host = new ToolExecutionComponent(
        name,
        `composed-${name}`,
        {},
        {},
        tools.get(name),
        { requestRender: vi.fn() } as any,
        process.cwd(),
      );
      expect(host.render(200).join("\n")).toContain(loadingLabel);

      host.markExecutionStarted();
      host.updateResult(
        { content: [{ type: "text", text: "model text" }], details: { rendering }, isError: false },
        false,
      );
      const settled = host.render(200).join("\n");
      expect(settled).toContain(rendering.collapsed.slice(2));
      expect(settled).not.toContain(loadingLabel);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("omits loading rows and timers from completed and result-less HTML exports", () => {
    vi.useFakeTimers();
    initTheme(undefined, false);
    const tools = new Map<string, any>();
    registerExtension({ on() {}, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
    const exporter = createToolHtmlRenderer({
      getToolDefinition: (name: string) => tools.get(name),
      theme,
      cwd: process.cwd(),
      width: 200,
    });
    const cases = [
      ["task_create", "Creating tasks…", renderTaskCreate([task()])],
      ["task_update", "Updating tasks…", renderTaskUpdate([{ before: task(), after: task({ status: "completed" }) }])],
      ["task_get", "Retrieving task…", renderTaskGet(task())],
      ["task_list", "Listing tasks…", renderTaskList([task()])],
    ] as const;

    for (const [name, loadingLabel, rendering] of cases) {
      const toolCallId = `export-${name}`;
      const call = exporter.renderCall(toolCallId, name, {});
      const result = exporter.renderResult(
        toolCallId,
        name,
        [{ type: "text", text: "model text" }],
        { rendering },
        false,
      );
      const html = JSON.stringify({ call, result });
      expect(call).toBe("");
      expect(result?.expanded).toContain(rendering.collapsed.slice(2));
      expect(html).not.toContain(loadingLabel);
      expect(html).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(vi.getTimerCount()).toBe(0);
    }

    expect(exporter.renderCall("export-result-less", "task_create", {})).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses host context errors for masking and safely handles missing context", () => {
    const tools = new Map<string, any>();
    registerExtension({ on() {}, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
    const result = { content: [{ type: "text", text: "unchanged model JSON/error text" }], details: undefined };
    for (const tool of tools.values()) {
      expect(tool.renderResult(result, { expanded: false, isPartial: false }, {}, { args: {}, isError: false }).render(200).join("\n").trimEnd()).toBe(
        "unchanged model JSON/error text",
      );
    }
    expect(tools.get("task_list").renderResult(
      { ...result, details: { rendering: null } },
      { expanded: true, isPartial: false },
      {},
      { args: {}, isError: false },
    ).render(200).join("\n").trimEnd()).toBe("unchanged model JSON/error text");

    const masked = tools.get("task_get").renderResult(
      { content: [{ type: "text", text: "internal secret" }], details: undefined },
      { expanded: true, isPartial: false },
      {},
      { args: { id: 7 }, isError: true },
    ).render(200).map((line: string) => line.trimEnd()).join("\n");
    expect(masked).toBe("✗ Failed to retrieve task #7\n  Unexpected internal error.");

    const partialContext = tools.get("task_update").renderResult(
      { content: [{ type: "text", text: "internal secret" }], details: { rendering: null } },
      { expanded: true, isPartial: false },
      {},
      undefined,
    ).render(200).map((line: string) => line.trimEnd()).join("\n");
    expect(partialContext).toBe("internal secret");

    const missingArgs = tools.get("task_get").renderResult(
      { content: [{ type: "text", text: "internal secret" }], details: { rendering: null } },
      { expanded: false, isPartial: false },
      {},
      { isError: true },
    ).render(200).join("\n").trimEnd();
    expect(missingArgs).toBe("✗ Failed to retrieve task #");
  });
});

describe("pending spinner theming", () => {
  function recordingTheme() {
    const calls: Array<[string, string]> = [];
    const fg = (color: string, text: string) => {
      calls.push([color, text]);
      return `<${color}>${text}</>`;
    };
    return { calls, theme: { fg } as any };
  }

  it("themes animated pending frames (accent) and labels (toolTitle) for all four tools", () => {
    vi.useFakeTimers();
    try {
      const cases = [
        ["task_create", "Creating tasks…"],
        ["task_update", "Updating tasks…"],
        ["task_get", "Retrieving task…"],
        ["task_list", "Listing tasks…"],
      ] as const;
      for (const [name, label] of cases) {
        const { calls, theme } = recordingTheme();
        const state: any = {};
        const component = renderTaskCall(label, {
          toolCallId: `themed-${name}`,
          executionStarted: false,
          isPartial: true,
          invalidate: vi.fn(),
          state,
        }, theme);
        expect(calls).toEqual([["accent", "⠋"], ["toolTitle", label]]);
        expect(component.render(200).join("\n")).toContain(`<accent>⠋</> <toolTitle>${label}</>`);
        calls.length = 0;
        vi.advanceTimersByTime(80);
        expect(calls).toEqual([["accent", "⠙"], ["toolTitle", label]]);
        expect(component.render(200).join("\n")).toContain(`<accent>⠙</> <toolTitle>${label}</>`);
        const themedLines = component.render(24);
        expect(themedLines.every((line) => visibleWidth(line) <= 24)).toBe(true);
        renderTaskCall(label, { toolCallId: `themed-${name}`, executionStarted: true, isPartial: false });
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("threads the host theme through all four registered renderCall labels", () => {
    vi.useFakeTimers();
    try {
      const tools = new Map<string, any>();
      registerExtension({ on() {}, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
      const cases = [
        ["task_create", { tasks: [{}, {}] }, "Creating tasks…"],
        ["task_update", { updates: [{}, {}] }, "Updating tasks…"],
        ["task_get", { id: 9 }, "Retrieving task…"],
        ["task_list", { status: "paused" }, "Listing tasks…"],
      ] as const;
      for (const [name, args, label] of cases) {
        const { calls, theme } = recordingTheme();
        const context: any = {
          args, toolCallId: `host-themed-${name}`, executionStarted: false,
          isPartial: true, invalidate: vi.fn(), state: {},
        };
        const component = tools.get(name).renderCall(args, theme, context);
        expect(calls).toEqual([["accent", "⠋"], ["toolTitle", label]]);
        expect(component.render(200).join("\n")).toContain(`<accent>⠋</> <toolTitle>${label}</>`);
        expect(component.render(200).join("\n")).not.toContain("99");
        context.lastComponent = component;
        context.isPartial = false;
        expect(tools.get(name).renderCall(args, theme, context).render(200)).toEqual([]);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("themes the static fallback label and refreshes the theme on reuse", () => {
    vi.useFakeTimers();
    try {
      const { calls, theme } = recordingTheme();
      const fallback = renderTaskCall("Listing tasks…", {
        executionStarted: false, isPartial: true, invalidate: vi.fn(), state: {},
      }, theme);
      expect(fallback).toBeInstanceOf(Text);
      expect(calls).toEqual([["toolTitle", "Listing tasks…"]]);
      expect(fallback.render(200).join("\n")).toContain("<toolTitle>Listing tasks…</>");
      expect(vi.getTimerCount()).toBe(0);

      const first = recordingTheme();
      const state: any = {};
      const spinner = renderTaskCall("Creating tasks…", {
        toolCallId: "theme-refresh", executionStarted: false,
        isPartial: true, invalidate: vi.fn(), state,
      }, first.theme);
      const second = recordingTheme();
      const reused = renderTaskCall("Creating tasks…", {
        toolCallId: "theme-refresh", executionStarted: true,
        isPartial: true, invalidate: vi.fn(), lastComponent: spinner, state,
      }, second.theme);
      expect(reused).toBe(spinner);
      expect(second.calls).toEqual([["accent", "⠋"], ["toolTitle", "Creating tasks…"]]);
      expect(spinner.render(200).join("\n")).toContain("<toolTitle>Creating tasks…</>");
      second.calls.length = 0;
      vi.advanceTimersByTime(80);
      expect(second.calls).toEqual([["accent", "⠙"], ["toolTitle", "Creating tasks…"]]);
      renderTaskCall("Creating tasks…", { toolCallId: "theme-refresh", executionStarted: true, isPartial: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the exact unstyled pending string when theme is missing or throws", () => {
    vi.useFakeTimers();
    try {
      const state: any = {};
      const plain = renderTaskCall("Retrieving task…", {
        toolCallId: "plain-pending", executionStarted: false,
        isPartial: true, invalidate: vi.fn(), state,
      });
      expect(plain.render(200).join("\n").trimEnd()).toBe("⠋ Retrieving task…");
      vi.advanceTimersByTime(80);
      expect(plain.render(200).join("\n").trimEnd()).toBe("⠙ Retrieving task…");
      renderTaskCall("Retrieving task…", { toolCallId: "plain-pending", executionStarted: true, isPartial: false });

      const throwing: any = { fg: () => { throw new Error("theme failed"); } };
      const fallbackState: any = {};
      const fallback = renderTaskCall("Retrieving task…", {
        toolCallId: "throw-pending", executionStarted: false,
        isPartial: true, invalidate: vi.fn(), state: fallbackState,
      }, throwing);
      expect(fallback.render(200).join("\n").trimEnd()).toBe("⠋ Retrieving task…");
      vi.advanceTimersByTime(80);
      expect(fallback.render(200).join("\n").trimEnd()).toBe("⠙ Retrieving task…");
      const staticFallback = renderTaskCall("Retrieving task…", {
        executionStarted: false, isPartial: true, invalidate: vi.fn(), state: {},
      }, throwing);
      expect(staticFallback.render(200).join("\n").trimEnd()).toBe("Retrieving task…");
      expect(renderTaskCall("Retrieving task…").render(200).join("\n").trimEnd()).toBe("Retrieving task…");
      renderTaskCall("Retrieving task…", { toolCallId: "throw-pending", executionStarted: true, isPartial: false });
      expect(vi.getTimerCount()).toBe(0);
      expect(fallbackState.taskCallSpinner).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
