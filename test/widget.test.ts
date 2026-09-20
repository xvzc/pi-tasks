import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  BLINK_INTERVAL_MS,
  ELAPSED_INTERVAL_MS,
  buildWidgetLines,
  createTaskWidget,
  formatElapsedDuration,
  formatTaskLine,
  renderWidgetLines,
  statusGlyph,
  themeColorFor,
  type ThemeLike,
} from "../src/widget.js";
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

const fakeTheme: ThemeLike = {
  fg: (_color: string, text: string) => `<${_color}>${text}</>`,
  bold: (text: string) => `*${text}*`,
  strikethrough: (text: string) => `~${text}~`,
};

/** Fixed clock: exactly 1d 1h 1m 1s after the default `createdAt`. */
const FIXED_NOW = Date.parse("2026-01-02T01:01:01.000Z");
const FIXED_ELAPSED = "1d 1h 1m 1s";

describe("plain rendering", () => {
  it("shows numeric id, attempt counter, optional [assignee], and subject", () => {
    // Pending lines show no duration; new attempts show `0s` on entry into `in_progress`.
    expect(formatTaskLine(task({ id: 3, subject: "Ship it" }), FIXED_NOW)).toBe(
      `  ■ #3 (0/9) Ship it`,
    );
    expect(formatTaskLine(task({ id: 3, subject: "Ship it", assignee: "api" }), FIXED_NOW)).toBe(
      `  ■ #3 (0/9) [api] Ship it`,
    );
    expect(
      formatTaskLine(task({ id: 3, subject: "Ship it", attempt: 2, maxAttempts: 3 }), FIXED_NOW),
    ).toBe(`  ■ #3 (2/3) Ship it`);
  });

  it("shows blockedBy ids after the subject only while pending", () => {
    expect(formatTaskLine(task({ id: 4, subject: "Wait", blockedBy: [1, 3] }), FIXED_NOW)).toBe(
      "  ■ #4 (0/9) Wait → (1, 3)",
    );
    expect(
      formatTaskLine(task({ id: 4, subject: "Run", status: "in_progress", blockedBy: [1, 3] }), FIXED_NOW),
    ).not.toContain("→");
    expect(
      formatTaskLine(task({ id: 4, subject: "Done", status: "completed", blockedBy: [1, 3] }), FIXED_NOW),
    ).not.toContain("→");
  });

  it("uses filled glyphs for every status", () => {
    expect(statusGlyph(task({ id: 1, subject: "a", status: "pending" }))).toBe("■");
    expect(statusGlyph(task({ id: 1, subject: "a", status: "in_progress" }))).toBe("■");
    expect(statusGlyph(task({ id: 1, subject: "a", status: "completed" }))).toBe("■");
  });

  it("builds widget lines with a header, and none for empty lists", () => {
    expect(buildWidgetLines([])).toEqual([]);
    const lines = buildWidgetLines(
      [
        task({ id: 3, subject: "c", assignee: "x" }),
        task({ id: 2, subject: "b", status: "in_progress" }),
        task({ id: 1, subject: "a", status: "completed", tookMs: 61_000 }),
      ],
      FIXED_NOW,
    );
    expect(lines[0]).toBe(`● 3 tasks (1 done) ${FIXED_ELAPSED}`);
    expect(lines[1]).toContain("#1");
    expect(lines[1]).toContain("1m 1s");
    expect(lines[1]).not.toContain("took");
    expect(lines[2]).toContain(`b ${FIXED_ELAPSED}`);
    expect(lines[3]).toContain("#3 (0/9) [x] c");
  });

  it("hides total time until a task starts and keeps zero after a start", () => {
    expect(buildWidgetLines([task({ id: 1, subject: "a" })], FIXED_NOW)[0]).toBe(
      "● 1 task (0 done)",
    );
    expect(
      buildWidgetLines([task({ id: 1, subject: "a", status: "in_progress" })], FIXED_NOW)[0],
    ).toBe(`● 1 task (0 done) ${FIXED_ELAPSED}`);
    expect(
      buildWidgetLines([task({ id: 1, subject: "a", status: "completed", tookMs: 5_000 })], FIXED_NOW)[0],
    ).toBe("● 1 task (1 done)");
    expect(
      buildWidgetLines([task({ id: 1, subject: "a", status: "completed", attempt: 1, tookMs: 500 })], FIXED_NOW)[0],
    ).toBe("● 1 task (1 done) 0s");
  });
});

describe("themed rendering", () => {
  it("renders default glyph colors per status", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "a" })], fakeTheme);
    expect(pending[1]).toMatch(/^  <dim>■<\/>/);
    const active = renderWidgetLines([task({ id: 2, subject: "b", status: "in_progress" })], fakeTheme);
    expect(active[1]).toMatch(/^  <success>■<\/>/);
    const done = renderWidgetLines([task({ id: 3, subject: "c", status: "completed" })], fakeTheme);
    expect(done[1]).toMatch(/^  <success>■<\/>/);
  });

  it("renders only a visible header total in dim", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "a" })], fakeTheme, undefined, true, FIXED_NOW);
    expect(pending[0]).toBe("<accent>● 1 task (0 done)</>");

    const active = renderWidgetLines(
      [task({ id: 1, subject: "a", status: "in_progress" })],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    );
    expect(active[0]).toBe(`<accent>● 1 task (0 done)</> <dim>${FIXED_ELAPSED}</>`);
  });

  it("styles subjects by status", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "pending" })], fakeTheme);
    expect(pending[1]).toContain("<text>pending</>");

    const active = renderWidgetLines(
      [task({ id: 2, subject: "active", status: "in_progress" })],
      fakeTheme,
    );
    expect(active[1]).toContain("<success>*active*</>");

    const done = renderWidgetLines([task({ id: 3, subject: "done", status: "completed" })], fakeTheme);
    expect(done[1]).toContain("<dim>done</>");
    expect(done[1]).not.toContain("~");
  });

  it("renders pending glyphs in the configured default color while keeping dependencies dim and the assignee/subject as text", () => {
    const lines = renderWidgetLines(
      [task({ id: 1, subject: "a", assignee: "api", color: "red", blockedBy: [2, 3] })],
      fakeTheme,
    );
    expect(lines[1]).toContain("<dim>■</>");
    expect(lines[1]).toContain("<text> [api]</>");
    expect(lines[1]).toContain("<text>a</>");
    expect(lines[1]).toContain("<dim> → (2, 3)</>");
    expect(lines[1]).not.toContain("<error>");
  });

  it("applies optional color to in-progress and completed glyphs", () => {
    const active = renderWidgetLines(
      [task({ id: 1, subject: "a", assignee: "api", status: "in_progress", color: "blue" })],
      fakeTheme,
    );
    expect(active[1]).toContain("<accent>■</>");
    expect(active[1]).toContain("<success>* [api]*</>");
    expect(active[1]).toContain("<success>*a*</>");
    const done = renderWidgetLines(
      [task({ id: 2, subject: "b", assignee: "api", status: "completed", color: "yellow" })],
      fakeTheme,
    );
    expect(done[1]).toContain("<warning>■</>");
    expect(done[1]).toContain("<dim> [api]</>");
    expect(done[1]).toContain("<dim>b</>");
    expect(done[1]).not.toContain("~");
  });

  it("leaves unknown colors on the default glyph color instead of throwing", () => {
    const lines = renderWidgetLines([task({ id: 1, subject: "a", assignee: "p", color: "not-a-color" })], fakeTheme);
    expect(lines[1]).toContain("<text> [p]</>");
    expect(lines[1]).toContain("<dim>■</>");
  });

  it("renders a same-width blank for in-progress glyphs when blink is off", () => {
    const on = renderWidgetLines(
      [task({ id: 1, subject: "a", status: "in_progress" })],
      fakeTheme,
      undefined,
      true,
    );
    const off = renderWidgetLines(
      [task({ id: 1, subject: "a", status: "in_progress" })],
      fakeTheme,
      undefined,
      false,
    );
    expect(on[1]).toContain("<success>■</>");
    expect(off[1]).toContain("<success> </>");
    expect(visibleWidth(off[1])).toBe(visibleWidth(on[1]));
  });

  it("maps known color names to theme colors", () => {
    expect(themeColorFor("red")).toBe("error");
    expect(themeColorFor("green")).toBe("success");
    expect(themeColorFor("yellow")).toBe("warning");
    expect(themeColorFor("blue")).toBe("accent");
    expect(themeColorFor("gray")).toBe("dim");
    expect(themeColorFor("mystery")).toBeUndefined();
    expect(themeColorFor(undefined)).toBeUndefined();
  });
});

describe("width-aware rendering", () => {
  const longSubject = `Plan the migration ${"very-long-detail ".repeat(20)}done`;
  const longAssignee = `assignee-${"x".repeat(120)}`;

  function mixedTasks(): Task[] {
    return [
      task({ id: 1, subject: longSubject, assignee: longAssignee, color: "red" }),
      task({ id: 2, subject: longSubject, status: "in_progress", assignee: longAssignee, color: "blue" }),
      task({ id: 3, subject: longSubject, status: "completed", color: "yellow" }),
      task({ id: 4, subject: longSubject, status: "completed" }),
    ];
  }

  // Theme mock that emits real ANSI escapes, exercising ANSI-aware truncation.
  const ansiTheme: ThemeLike = {
    fg: (color: string, text: string) => `\x1b[${color.length}m${text}\x1b[39m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
  };

  it("fits long subjects and assignees within 80 columns", () => {
    for (const theme of [fakeTheme, ansiTheme]) {
      const lines = renderWidgetLines(mixedTasks(), theme, 80);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(80);
      }
    }
    // Unbounded baseline really is unbounded (guards the regression).
    expect(mixedTasks().some((t) => formatTaskLine(t).length > 80)).toBe(true);
  });

  it("preserves coloring/status semantics when truncating to 80 columns", () => {
    const lines = renderWidgetLines(
      [task({ id: 1, subject: "short", assignee: "api", color: "red" })],
      fakeTheme,
      80,
    );
    expect(lines[1]).toContain("<dim>■</>");
    expect(lines[1]).toContain("<text> [api]</>");
    expect(lines[1]).not.toContain("<error>");
    const completed = renderWidgetLines(
      [task({ id: 7, subject: "short", status: "completed" })],
      fakeTheme,
      80,
    );
    expect(completed[1]).toContain("<success>■</>");
    expect(completed[1]).toContain("<dim>short</>");
    expect(completed[1]).not.toContain("~");
    expect(lines[0]).toContain("● 1 task");
  });

  it.each([10, 5, 2, 1])("fits every line within a very narrow width of %i columns", (width) => {
    for (const theme of [fakeTheme, ansiTheme]) {
      const lines = renderWidgetLines(mixedTasks(), theme, width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("passes non-positive widths through without throwing", () => {
    for (const width of [0, -3, Number.NaN]) {
      expect(() => renderWidgetLines(mixedTasks(), fakeTheme, width)).not.toThrow();
    }
  });
});

describe("widget callback (integration-style)", () => {
  const longSubject = `Do the thing ${"with-extra-context ".repeat(15)}finally`;

  function tuiWithColumns(columns: number) {
    return { terminal: { columns } };
  }

  it("reads live tui.terminal.columns so lines fit an 80-column terminal", () => {
    const tui = tuiWithColumns(80);
    const component = createTaskWidget(
      [task({ id: 1, subject: longSubject, assignee: "api", color: "red", status: "in_progress" })],
      tui,
      fakeTheme,
    );
    const lines = component.render();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    component.dispose();
  });

  it("tracks live resizes to very narrow widths", () => {
    const tui = tuiWithColumns(80);
    const tasks = [task({ id: 1, subject: longSubject, status: "completed" })];
    const component = createTaskWidget(tasks, tui, fakeTheme);
    tui.terminal.columns = 12;
    const lines = component.render();
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    }
    component.dispose();
  });

  it("prefers an explicit positive render width over terminal columns", () => {
    const component = createTaskWidget([task({ id: 1, subject: longSubject })], tuiWithColumns(80), fakeTheme);
    const lines = component.render(24);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    }
    component.dispose();
  });

  it("renders themed ANSI output within width via the callback", () => {
    const ansiTheme: ThemeLike = {
      fg: (color: string, text: string) => `\x1b[${color.length}m${text}\x1b[39m`,
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
      strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
    };
    const component = createTaskWidget(
      [task({ id: 1, subject: longSubject, assignee: "api", color: "red", status: "in_progress" })],
      tuiWithColumns(80),
      ansiTheme,
    );
    const lines = component.render();
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(lines.join("\n")).toContain("\x1b[");
    component.dispose();
  });
});

describe("in-progress blink", () => {
  function tuiWithRender() {
    return { terminal: { columns: 80 }, requestRender: vi.fn() };
  }

  it(`toggles the in-progress glyph every ${BLINK_INTERVAL_MS} ms`, () => {
    expect(BLINK_INTERVAL_MS).toBe(250);
    vi.useFakeTimers();
    try {
      const tui = tuiWithRender();
      const component = createTaskWidget(
        [task({ id: 1, subject: "a", status: "in_progress" })],
        tui,
        fakeTheme,
      );
      expect(component.render()[1]).toContain("<success>■</>");
      vi.advanceTimersByTime(250);
      expect(component.render()[1]).toContain("<success> </>");
      expect(tui.requestRender).toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(component.render()[1]).toContain("<success>■</>");
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops requesting redraws after dispose", () => {
    vi.useFakeTimers();
    try {
      const tui = tuiWithRender();
      const component = createTaskWidget(
        [task({ id: 1, subject: "a", status: "in_progress" })],
        tui,
        fakeTheme,
      );
      component.dispose();
      vi.advanceTimersByTime(1000);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no timers when no in-progress task remains", () => {
    vi.useFakeTimers();
    try {
      const tui = tuiWithRender();
      const component = createTaskWidget(
        [
          task({ id: 1, subject: "a" }),
          task({ id: 2, subject: "b", status: "completed" }),
        ],
        tui,
        fakeTheme,
      );
      // Neither the 250 ms blink tick nor the 1 s elapsed tick runs.
      vi.advanceTimersByTime(5000);
      expect(tui.requestRender).not.toHaveBeenCalled();
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("attempt counter rendering", () => {
  it("shows the counter immediately after the id in plain lines", () => {
    expect(formatTaskLine(task({ id: 7, subject: "s", attempt: 2, maxAttempts: 5 }), FIXED_NOW)).toBe(
      `  ■ #7 (2/5) s`,
    );
    const lines = buildWidgetLines([task({ id: 1, subject: "a", attempt: 1, maxAttempts: 9 })], FIXED_NOW);
    expect(lines[1]).toBe(`  ■ #1 (1/9) a`);
  });

  it("shows the dim counter after the id for every status without changing glyph/subject styles", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "a", attempt: 0, maxAttempts: 9 })], fakeTheme);
    expect(pending[1]).toContain("<dim>#1 (0/9)</>");
    expect(pending[1]).toMatch(/^  <dim>■<\/>/);
    expect(pending[1]).toContain("<text>a</>");

    const active = renderWidgetLines(
      [task({ id: 2, subject: "b", status: "in_progress", attempt: 3, maxAttempts: 9 })],
      fakeTheme,
    );
    expect(active[1]).toContain("<dim>#2 (3/9)</>");
    expect(active[1]).toContain("<success>■</>");
    expect(active[1]).toContain("<success>*b*</>");

    const done = renderWidgetLines(
      [task({ id: 3, subject: "c", status: "completed", attempt: 2, maxAttempts: 2 })],
      fakeTheme,
    );
    expect(done[1]).toContain("<dim>#3 (2/2)</>");
    expect(done[1]).toContain("<success>■</>");
    expect(done[1]).toContain("<dim>c</>");
    expect(done[1]).not.toContain("~");
  });

  it("keeps the counter next to the id when an assignee is present", () => {
    expect(
      formatTaskLine(task({ id: 1, subject: "a", assignee: "api", attempt: 1, maxAttempts: 2 }), FIXED_NOW),
    ).toBe(`  ■ #1 (1/2) [api] a`);
    const lines = renderWidgetLines(
      [task({ id: 1, subject: "a", assignee: "api", attempt: 1, maxAttempts: 2 })],
      fakeTheme,
    );
    expect(lines[1].indexOf("#1 (1/2)")).toBeLessThan(lines[1].indexOf("[api]"));
  });

  it("keeps the counter visible when the in-progress glyph blinks off", () => {
    const off = renderWidgetLines(
      [task({ id: 4, subject: "a", status: "in_progress", attempt: 1, maxAttempts: 9 })],
      fakeTheme,
      undefined,
      false,
    );
    expect(off[1]).toContain("<success> </>");
    expect(off[1]).toContain("#4 (1/9)");
  });

  it("is presentation only and still truncates within width", () => {
    const original = task({ id: 1, subject: "a", attempt: 1, maxAttempts: 9 });
    const snapshot = { ...original };
    formatTaskLine(original);
    renderWidgetLines([original], fakeTheme, 80);
    expect(original).toEqual(snapshot);
    const longSubject = `x ${"y".repeat(200)}`;
    const lines = renderWidgetLines([task({ id: 1, subject: longSubject, attempt: 8, maxAttempts: 9 })], fakeTheme, 40);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe("elapsed duration", () => {
  it("formats nonzero day/hour/minute/second components in order and omits zeros", () => {
    expect(formatElapsedDuration("2026-01-01T00:00:00.000Z", FIXED_NOW)).toBe("1d 1h 1m 1s");
    expect(formatElapsedDuration("2026-01-02T01:00:31.000Z", FIXED_NOW)).toBe("30s");
    expect(formatElapsedDuration("2026-01-02T01:00:01.000Z", FIXED_NOW)).toBe("1m");
    expect(formatElapsedDuration("2026-01-02T00:01:01.000Z", FIXED_NOW)).toBe("1h");
    expect(formatElapsedDuration("2026-01-01T01:01:01.000Z", FIXED_NOW)).toBe("1d");
    expect(formatElapsedDuration("2026-01-02T01:01:01.000Z", FIXED_NOW)).toBe("");
    // Future timestamps clamp to zero rather than going negative, and zero-valued output stays hidden.
    expect(formatElapsedDuration("2026-01-03T00:00:00.000Z", FIXED_NOW)).toBe("");
    expect(formatTaskLine(task({ id: 1, subject: "fresh", createdAt: "2026-01-02T01:01:01.000Z" }), FIXED_NOW)).toBe(
      "  ■ #1 (0/9) fresh",
    );
  });

  it("shows running attempt time only while in progress and the frozen duration once completed", () => {
    const lines = buildWidgetLines(
      [
        task({ id: 1, subject: "a" }),
        task({ id: 2, subject: "b", status: "in_progress" }),
        task({ id: 3, subject: "c", status: "completed", tookMs: 90_000 }),
      ],
      FIXED_NOW,
    );
    expect(lines[1]).toBe("  ■ #1 (0/9) a");
    expect(lines[2].endsWith(`b ${FIXED_ELAPSED}`)).toBe(true);
    expect(lines[3].endsWith("c 1m 30s")).toBe(true);
    expect(lines[3]).not.toContain("took");
  });

  it("shows 0s immediately for a newly in_progress task in plain and themed lines", () => {
    const started = task({ id: 1, subject: "s", status: "in_progress", startedAt: "2026-01-02T01:01:01.000Z" });
    expect(formatTaskLine(started, FIXED_NOW)).toBe("  ■ #1 (0/9) s 0s");
    const themed = renderWidgetLines([started], fakeTheme, undefined, true, FIXED_NOW);
    expect(themed[1]).toContain("<dim>0s</>");
    expect(themed[1]).not.toContain("took");
  });

  it("renders attempt and completed durations dim in themed lines", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "s" })], fakeTheme, undefined, true, FIXED_NOW);
    expect(pending[1]).not.toContain(`<dim>${FIXED_ELAPSED}</>`);
    const active = renderWidgetLines(
      [task({ id: 1, subject: "s", status: "in_progress" })],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    );
    expect(active[1]).toContain(`<dim>${FIXED_ELAPSED}</>`);
    const done = renderWidgetLines(
      [task({ id: 1, subject: "s", status: "completed", tookMs: 30_000 })],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    );
    expect(done[1]).toContain("<dim>30s</>");
    expect(done[1]).not.toContain("took");
  });

  it("includes the attempt duration in the plain fallback when the theme rejects a color", () => {
    const throwingTheme: ThemeLike = {
      fg: () => {
        throw new Error("bad color");
      },
      bold: (text: string) => text,
      strikethrough: (text: string) => text,
    };
    const lines = renderWidgetLines(
      [task({ id: 1, subject: "s", status: "in_progress" })],
      throwingTheme,
      undefined,
      true,
      FIXED_NOW,
    );
    expect(lines[1]).toContain(`s ${FIXED_ELAPSED}`);
  });

  it("keeps pure rendering deterministic for a supplied current time", () => {
    const t = task({ id: 1, subject: "s" });
    expect(formatTaskLine(t, FIXED_NOW)).toBe(formatTaskLine(t, FIXED_NOW));
    expect(buildWidgetLines([t], FIXED_NOW)).toEqual(buildWidgetLines([t], FIXED_NOW));
    expect(renderWidgetLines([t], fakeTheme, undefined, true, FIXED_NOW)).toEqual(
      renderWidgetLines([t], fakeTheme, undefined, true, FIXED_NOW),
    );
  });

  it(`requests redraws every ${ELAPSED_INTERVAL_MS} ms only while a task is in progress`, () => {
    expect(ELAPSED_INTERVAL_MS).toBe(1000);
    vi.useFakeTimers();
    try {
      const tui = { terminal: { columns: 80 }, requestRender: vi.fn() };
      const component = createTaskWidget(
        [task({ id: 1, subject: "a", status: "in_progress" })],
        tui,
        fakeTheme,
        FIXED_NOW,
      );
      expect(component.render()[0]).toContain("(0 done)");
      vi.advanceTimersByTime(1000);
      expect(tui.requestRender).toHaveBeenCalled();
      component.dispose();
      vi.advanceTimersByTime(5000);
      const callsAfterDispose = (tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length;

      const idleTui = { terminal: { columns: 80 }, requestRender: vi.fn() };
      const idle = createTaskWidget([task({ id: 1, subject: "a" })], idleTui, fakeTheme, FIXED_NOW);
      expect(idle.render()[0]).toContain("(0 done)");
      expect(idle.render()[0]).not.toContain("0s");
      vi.advanceTimersByTime(5000);
      expect(idleTui.requestRender).not.toHaveBeenCalled();
      idle.dispose();
      expect((tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances attempt text via the widget clock without changing the snapshot", () => {
    let now = FIXED_NOW;
    const tasks = [task({ id: 1, subject: "s", status: "in_progress" })];
    const component = createTaskWidget(tasks, {}, fakeTheme, () => now);
    expect(component.render()[1]).toContain(FIXED_ELAPSED);
    now += 60_000;
    expect(component.render()[1]).toContain("1d 1h 2m 1s");
    // A per-render override wins over the provider clock.
    expect(component.render(undefined, FIXED_NOW)[1]).toContain(FIXED_ELAPSED);
    component.dispose();
  });
});
