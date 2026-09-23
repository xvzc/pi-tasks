import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  remainingRetries,
  assigneeColumnWidth,
  BLINK_INTERVAL_MS,
  ELAPSED_INTERVAL_MS,
  buildWidgetLines,
  createTaskWidget,
  formatElapsedDuration,
  formatTaskLine,
  idColumnWidth,
  retryColumnWidth,
  renderWidgetLines,
  statusGlyph,
  type ThemeLike,
} from "../src/widget.js";
import { DEFAULT_CONFIG, type PiTasksConfig } from "../src/config.js";
import type { Task } from "../src/types.js";

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

/** Assignee display enabled: every `@assignee` assertion below pins this config. */
const assigneeConfig: PiTasksConfig = { ...DEFAULT_CONFIG, enableAssignee: true };

describe("plain rendering", () => {
  it("shows numeric id, remaining attempts, optional @assignee, and subject", () => {
    // Pending lines show no duration; new attempts show `0s` on entry into `in_progress`.
    // The indicator shows remaining total attempts: 9 - 0 = 9, 3 - 2 = 1.
    expect(formatTaskLine(task({ id: 3, subject: "Ship it" }), FIXED_NOW)).toBe(
      `  ◌ #3 ↻9 Ship it`,
    );
    expect(formatTaskLine(task({ id: 3, subject: "Ship it", assignee: "api" }), FIXED_NOW, assigneeConfig)).toBe(
      `  ◌ #3 ↻9 @api Ship it`,
    );
    expect(
      formatTaskLine(task({ id: 3, subject: "Ship it", attempt: 2, maxAttempts: 3 }), FIXED_NOW),
    ).toBe(`  ■ #3 ↻1 Ship it`);
  });

  it("shows blockedBy ids after the subject only while pending", () => {
    expect(formatTaskLine(task({ id: 4, subject: "Wait", blockedBy: [1, 3] }), FIXED_NOW)).toBe(
      "  ◌ #4 ↻9 Wait → (1, 3)",
    );
    expect(
      formatTaskLine(task({ id: 4, subject: "Run", status: "in_progress", blockedBy: [1, 3] }), FIXED_NOW),
    ).not.toContain("→");
    expect(
      formatTaskLine(task({ id: 4, subject: "Done", status: "completed", blockedBy: [1, 3] }), FIXED_NOW),
    ).not.toContain("→");
  });

  it("uses status-specific default glyphs", () => {
    expect(statusGlyph(task({ id: 1, subject: "a", status: "pending" }))).toBe("◌");
    expect(statusGlyph(task({ id: 1, subject: "a", status: "in_progress" }))).toBe("◌");
    expect(statusGlyph(task({ id: 1, subject: "a", status: "completed" }))).toBe("●");
    expect(statusGlyph(task({ id: 1, subject: "a", status: "deleted" }))).toBe("⌫");
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
      undefined,
      assigneeConfig,
    );
    expect(lines[0]).toBe(`● Tasks · 3 total · 1 done · ${FIXED_ELAPSED}`);
    expect(lines[1]).toContain("#1");
    expect(lines[1]).toContain("1m 1s");
    expect(lines[1]).not.toContain("took");
    expect(lines[2]).toContain(`b ${FIXED_ELAPSED}`);
    expect(lines[3]).toContain("#3 ↻9 @x c");
  });

  it("keeps deleted tombstones visible in plain lines and header counts", () => {
    const lines = buildWidgetLines([task({ id: 1, subject: "obsolete", status: "deleted", tookMs: 500 })], FIXED_NOW);
    expect(lines[0]).toBe("● Tasks · 1 total · 0 done · 1 deleted");
    expect(lines[1]).toContain("obsolete [deleted] 0s");
  });

  it("hides total time until a task starts and keeps zero after a start", () => {
    expect(buildWidgetLines([task({ id: 1, subject: "a" })], FIXED_NOW)[0]).toBe(
      "● Tasks · 1 total · 0 done",
    );
    expect(
      buildWidgetLines([task({ id: 1, subject: "a", status: "in_progress" })], FIXED_NOW)[0],
    ).toBe(`● Tasks · 1 total · 0 done · ${FIXED_ELAPSED}`);
    expect(
      buildWidgetLines([task({ id: 1, subject: "a", status: "completed", tookMs: 5_000 })], FIXED_NOW)[0],
    ).toBe("● Tasks · 1 total · 1 done");
    expect(
      buildWidgetLines([task({ id: 1, subject: "a", status: "completed", attempt: 1, tookMs: 500 })], FIXED_NOW)[0],
    ).toBe("● Tasks · 1 total · 1 done · 0s");
  });
});

describe("themed rendering", () => {
  it("renders default glyph colors per status", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "a" })], fakeTheme);
    expect(pending[1]).toMatch(/^  <dim>◌<\/>/);
    const active = renderWidgetLines([task({ id: 2, subject: "b", status: "in_progress" })], fakeTheme);
    expect(active[1]).toMatch(/^  <success>◌<\/>/);
    const done = renderWidgetLines([task({ id: 3, subject: "c", status: "completed" })], fakeTheme);
    expect(done[1]).toMatch(/^  <success>●<\/>/);
    const deleted = renderWidgetLines([task({ id: 4, subject: "d", status: "deleted" })], fakeTheme);
    expect(deleted[1]).toMatch(/^  <dim>⌫<\/>/);
  });

  it("renders the header title in accent and the stats tail in dim", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "a" })], fakeTheme, undefined, true, FIXED_NOW);
    expect(pending[0]).toBe("<accent>● *Tasks*</><dim> · 1 total · 0 done</>");
    expect(pending[0]).toContain("<accent>● *Tasks*</>");
    expect(pending[0]).toContain("<dim> · 1 total · 0 done</>");
    expect(pending[0]).toContain("*Tasks*");
    expect(pending[0]).not.toContain("*1 total*");
    expect(pending[0]).not.toContain("*0 done*");

    const active = renderWidgetLines(
      [task({ id: 1, subject: "a", status: "in_progress" })],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    );
    expect(active[0]).toBe(`<accent>● *Tasks*</><dim> · 1 total · 0 done · ${FIXED_ELAPSED}</>`);
    expect(active[0]).toContain("<accent>● *Tasks*</>");
    expect(active[0]).toContain(`<dim> · 1 total · 0 done · ${FIXED_ELAPSED}</>`);
    expect(active[0]).not.toContain("*1 total*");
    expect(active[0]).not.toContain("*0 done*");
  });

  it("styles subjects by status", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "pending" })], fakeTheme);
    expect(pending[1]).toContain("<text>pending</>");
    expect(pending[1]).not.toContain("*pending*");

    const active = renderWidgetLines(
      [task({ id: 2, subject: "active", status: "in_progress" })],
      fakeTheme,
    );
    expect(active[1]).toContain("<text>*active*</>");

    const done = renderWidgetLines([task({ id: 3, subject: "done", status: "completed" })], fakeTheme);
    expect(done[1]).toContain("<dim>done</>");
    expect(done[1]).not.toContain("~");

    const paused = renderWidgetLines(
      [task({ id: 4, subject: "broken", status: "paused" })],
      fakeTheme,
    );
    expect(paused[1]).toContain("<text>broken</>");
    expect(paused[1]).not.toContain("~");

    const deleted = renderWidgetLines(
      [task({ id: 5, subject: "obsolete", assignee: "old", status: "deleted" })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(deleted[0]).toContain("1 deleted");
    expect(deleted[1]).toContain("<dim>~obsolete~</>");
    expect(deleted[1]).toContain("<dim>~@old~</>");
  });

  it("keeps pending content styling fixed while deriving its glyph from attempt", () => {
    const fresh = renderWidgetLines(
      [task({ id: 1, subject: "a", assignee: "api", blockedBy: [2, 3] })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(fresh[1]).toContain("<dim>◌</>");
    expect(fresh[1]).toContain("<text>@api</>");
    expect(fresh[1]).toContain("<text>a</>");
    expect(fresh[1]).toContain("<dim> → (2, 3)</>");

    const retried = renderWidgetLines(
      [task({ id: 1, subject: "a", assignee: "api", attempt: 1 })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(retried[1]).toContain("<warning>■</>");
    expect(retried[1]).toContain("<text>@api</>");
    expect(retried[1]).toContain("<text>a</>");
  });

  it("uses fixed glyph and content styling for in-progress and completed tasks", () => {
    const active = renderWidgetLines(
      [task({ id: 1, subject: "a", assignee: "api", status: "in_progress" })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(active[1]).toContain("<success>◌</>");
    expect(active[1]).toContain("<text>*@api*</>");
    expect(active[1]).toContain("<text>*a*</>");
    const done = renderWidgetLines(
      [task({ id: 2, subject: "b", assignee: "api", status: "completed" })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(done[1]).toContain("<success>●</>");
    expect(done[1]).toContain("<dim>@api</>");
    expect(done[1]).toContain("<dim>b</>");
    expect(done[1]).not.toContain("~");
  });

  it("renders in-progress subjects/assignees as text+bold with success glyph and dim elapsed", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "p" })], fakeTheme);
    expect(pending[1]).toContain("<text>p</>");
    expect(pending[1]).not.toContain("*p*");

    const active = renderWidgetLines(
      [task({ id: 2, subject: "a", assignee: "api", status: "in_progress" })],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
      undefined,
      assigneeConfig,
    );
    expect(active[1]).toContain("<success>◌</>");
    expect(active[1]).toContain("<text>*a*</>");
    expect(active[1]).toContain("<text>*@api*</>");
    expect(active[1]).toContain(`<dim>${FIXED_ELAPSED}</>`);

    const done = renderWidgetLines(
      [task({ id: 3, subject: "d", status: "completed", tookMs: 30_000 })],
      fakeTheme,
    );
    expect(done[1]).toContain("<success>●</>");
    expect(done[1]).toContain("<dim>d</>");
    expect(done[1]).toContain("<dim>30s</>");
    expect(done[1]).not.toContain("~");

    const paused = renderWidgetLines(
      [task({ id: 4, subject: "f", status: "paused", tookMs: 30_000 })],
      fakeTheme,
    );
    expect(paused[1]).toContain("<warning>⏸</>");
    expect(paused[1]).toContain("<text>f</>");
    expect(paused[1]).toContain("<dim>30s</>");
    expect(paused[1]).not.toContain("~");
    expect(paused[1]).not.toContain("<dim>f</>");
  });

  it("renders paused glyph in warning while paused subject matches pending subject styling", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "same" })], fakeTheme);
    const paused = renderWidgetLines(
      [task({ id: 2, subject: "same", assignee: "api", status: "paused", tookMs: 30_000 })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    const pendingAssignee = renderWidgetLines(
      [task({ id: 3, subject: "same", assignee: "api" })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(paused[1]).toContain("<warning>⏸</>");
    expect(paused[1]).toContain("<text>same</>");
    expect(paused[1]).toContain("<text>@api</>");
    expect(pending[1]).toContain("<text>same</>");
    expect(pendingAssignee[1]).toContain("<text>@api</>");
    expect(paused[1]).not.toContain("<dim>same</>");
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
    expect(on[1]).toContain("<success>◌</>");
    expect(off[1]).toContain("<success> </>");
    expect(visibleWidth(off[1])).toBe(visibleWidth(on[1]));
  });

});

describe("width-aware rendering", () => {
  const longSubject = `Plan the migration ${"very-long-detail ".repeat(20)}done`;
  const longAssignee = `assignee-${"x".repeat(120)}`;

  function mixedTasks(): Task[] {
    return [
      task({ id: 1, subject: longSubject, assignee: longAssignee }),
      task({ id: 2, subject: longSubject, status: "in_progress", assignee: longAssignee }),
      task({ id: 3, subject: longSubject, status: "completed" }),
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
      [task({ id: 1, subject: "short", assignee: "api" })],
      fakeTheme,
      80,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(lines[1]).toContain("<dim>◌</>");
    expect(lines[1]).toContain("<text>@api</>");
    const completed = renderWidgetLines(
      [task({ id: 7, subject: "short", status: "completed" })],
      fakeTheme,
      80,
    );
    expect(completed[1]).toContain("<success>●</>");
    expect(completed[1]).toContain("<dim>short</>");
    expect(completed[1]).not.toContain("~");
    expect(lines[0]).toContain("● *Tasks*<");
    expect(lines[0]).toContain("1 total");
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
      [task({ id: 1, subject: longSubject, assignee: "api", status: "in_progress" })],
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
      [task({ id: 1, subject: longSubject, assignee: "api", status: "in_progress" })],
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

  it(`advances the in-progress glyph every ${BLINK_INTERVAL_MS} ms`, () => {
    expect(BLINK_INTERVAL_MS).toBe(250);
    vi.useFakeTimers();
    try {
      const tui = tuiWithRender();
      const component = createTaskWidget(
        [task({ id: 1, subject: "a", status: "in_progress" })],
        tui,
        fakeTheme,
      );
      for (const frame of ["◌", "○", "⨀", "◉", "●", "◉", "⨀", "○", "◌"]) {
        expect(component.render()[1]).toContain(`<success>${frame}</>`);
        vi.advanceTimersByTime(BLINK_INTERVAL_MS);
      }
      expect(tui.requestRender).toHaveBeenCalled();
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

  it("updates the mounted snapshot and timer lifecycle without replacement", () => {
    vi.useFakeTimers();
    try {
      const tui = tuiWithRender();
      const component = createTaskWidget([task({ id: 1, subject: "pending" })], tui, fakeTheme);

      component.update([task({ id: 1, subject: "running", status: "in_progress" })]);
      expect(component.render()[1]).toContain("running");
      tui.requestRender.mockClear();
      vi.advanceTimersByTime(BLINK_INTERVAL_MS);
      expect(tui.requestRender).toHaveBeenCalled();

      component.update([task({ id: 1, subject: "done", status: "completed" })]);
      expect(component.render()[1]).toContain("done");
      tui.requestRender.mockClear();
      vi.advanceTimersByTime(ELAPSED_INTERVAL_MS * 2);
      expect(tui.requestRender).not.toHaveBeenCalled();
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("remaining-attempts indicator rendering", () => {
  it("shows the remaining-attempt count immediately after the id in plain lines", () => {
    // remaining attempts = max(0, max - attempt): 5 - 2 = 3, 9 - 1 = 8.
    expect(formatTaskLine(task({ id: 7, subject: "s", attempt: 2, maxAttempts: 5 }), FIXED_NOW)).toBe(
      `  ■ #7 ↻3 s`,
    );
    const lines = buildWidgetLines([task({ id: 1, subject: "a", attempt: 1, maxAttempts: 9 })], FIXED_NOW);
    expect(lines[1]).toBe(`  ■ #1 ↻8 a`);
  });

  it("shows the dim remaining-attempt count after the id for every status without changing glyph/subject styles", () => {
    const pending = renderWidgetLines([task({ id: 1, subject: "a", attempt: 0, maxAttempts: 9 })], fakeTheme);
    expect(pending[1]).toContain("<dim>#1 ↻9</>");
    expect(pending[1]).toMatch(/^  <dim>◌<\/>/);
    expect(pending[1]).toContain("<text>a</>");

    const active = renderWidgetLines(
      [task({ id: 2, subject: "b", status: "in_progress", attempt: 3, maxAttempts: 9 })],
      fakeTheme,
    );
    expect(active[1]).toContain("<dim>#2 ↻6</>");
    expect(active[1]).toContain("<success>◌</>");
    expect(active[1]).toContain("<text>*b*</>");

    const done = renderWidgetLines(
      [task({ id: 3, subject: "c", status: "completed", attempt: 2, maxAttempts: 2 })],
      fakeTheme,
    );
    expect(done[1]).toContain("<dim>#3 ↻0</>");
    expect(done[1]).toContain("<success>●</>");
    expect(done[1]).toContain("<dim>c</>");
    expect(done[1]).not.toContain("~");
  });

  it("keeps the remaining-attempt count next to the id when an assignee is present", () => {
    expect(
      formatTaskLine(task({ id: 1, subject: "a", assignee: "api", attempt: 1, maxAttempts: 2 }), FIXED_NOW, assigneeConfig),
    ).toBe(`  ■ #1 ↻1 @api a`);
    const lines = renderWidgetLines(
      [task({ id: 1, subject: "a", assignee: "api", attempt: 1, maxAttempts: 2 })],
      fakeTheme,
      undefined,
      true,
      undefined,
      undefined,
      assigneeConfig,
    );
    expect(lines[1].indexOf("#1 ↻1")).toBeLessThan(lines[1].indexOf("@api"));
  });

  it("keeps the remaining-attempt count visible when the in-progress glyph blinks off", () => {
    const off = renderWidgetLines(
      [task({ id: 4, subject: "a", status: "in_progress", attempt: 1, maxAttempts: 9 })],
      fakeTheme,
      undefined,
      false,
    );
    expect(off[1]).toContain("<success> </>");
    expect(off[1]).toContain("#4 ↻8");
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
      "  ◌ #1 ↻9 fresh",
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
    expect(lines[1]).toBe("  ◌ #1 ↻9 a");
    expect(lines[2].endsWith(`b ${FIXED_ELAPSED}`)).toBe(true);
    expect(lines[3].endsWith("c 1m 30s")).toBe(true);
    expect(lines[3]).not.toContain("took");
  });

  it("shows 0s immediately for a newly in_progress task in plain and themed lines", () => {
    const started = task({ id: 1, subject: "s", status: "in_progress", startedAt: "2026-01-02T01:01:01.000Z" });
    expect(formatTaskLine(started, FIXED_NOW)).toBe("  ◌ #1 ↻9 s 0s");
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
      expect(component.render()[0]).toContain("· 0 done");
      vi.advanceTimersByTime(1000);
      expect(tui.requestRender).toHaveBeenCalled();
      component.dispose();
      vi.advanceTimersByTime(5000);
      const callsAfterDispose = (tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length;

      const idleTui = { terminal: { columns: 80 }, requestRender: vi.fn() };
      const idle = createTaskWidget([task({ id: 1, subject: "a" })], idleTui, fakeTheme, FIXED_NOW);
      expect(idle.render()[0]).toContain("· 0 done");
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

describe("remaining-attempts indicator mappings", () => {
  it("counts every attempt including the first", () => {
    // attempt 0 leaves maxAttempts; each further attempt removes one more.
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 0, maxAttempts: 8 }))).toBe(" ↻8");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 1, maxAttempts: 8 }))).toBe(" ↻7");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 2, maxAttempts: 8 }))).toBe(" ↻6");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 8, maxAttempts: 8 }))).toBe(" ↻0");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 2, maxAttempts: 3 }))).toBe(" ↻1");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 1, maxAttempts: 2 }))).toBe(" ↻1");
  });

  it("maps exhausted to ↻0", () => {
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 9, maxAttempts: 9 }))).toBe(" ↻0");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 0, maxAttempts: 9 }))).toBe(" ↻9");
  });

  it("omits the indicator for unlimited tasks", () => {
    expect(remainingRetries(task({ id: 1, subject: "x", maxAttempts: 0 }))).toBe("");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 7, maxAttempts: 0 }))).toBe("");
    expect(formatTaskLine(task({ id: 1, subject: "Free", maxAttempts: 0 }), FIXED_NOW)).toBe(
      "  ◌ #1 Free",
    );
    const lines = renderWidgetLines(
      [task({ id: 1, subject: "Free", status: "in_progress", attempt: 3, maxAttempts: 0 })],
      fakeTheme,
    );
    expect(lines[1]).toContain("<dim>#1</>");
    expect(lines[1]).not.toContain("↻");
  });

  it("clamps over-consumed attempts to ↻0", () => {
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 5, maxAttempts: 3 }))).toBe(" ↻0");
  });

  it("renders exact counts for large caps without quantization", () => {
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 0, maxAttempts: 30 }))).toBe(" ↻30");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 10, maxAttempts: 25 }))).toBe(" ↻15");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 29, maxAttempts: 30 }))).toBe(" ↻1");
    expect(remainingRetries(task({ id: 1, subject: "x", attempt: 12, maxAttempts: 24 }))).toBe(" ↻12");
  });

  it("renders the remaining-attempt count in plain and themed widget lines without numeric counters", () => {
    const lines = buildWidgetLines([task({ id: 1, subject: "a", attempt: 1, maxAttempts: 9 })], FIXED_NOW);
    expect(lines[1]).toBe("  ■ #1 ↻8 a");
    const themed = renderWidgetLines(
      [task({ id: 1, subject: "a", attempt: 1, maxAttempts: 9 })],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    );
    expect(themed[1]).toContain("<dim>#1 ↻8</>");
    expect(themed[1]).not.toContain("(1/9)");
  });
});

describe("id column alignment", () => {
  function alignedTasks(): Task[] {
    return [
      task({ id: 9, subject: "Sample task 9", assignee: "unassigned", maxAttempts: 8 }),
      task({ id: 10, subject: "Sample task 10", assignee: "unassigned", maxAttempts: 8 }),
      task({ id: 11, subject: "Sample task 11", assignee: "unassigned", maxAttempts: 8 }),
    ];
  }

  it("left-aligns ids so the remaining-attempts column starts at a consistent position", () => {
    const lines = buildWidgetLines(alignedTasks(), FIXED_NOW, undefined, assigneeConfig);
    expect(lines.slice(1)).toEqual([
      "  ◌ #9  ↻8 @unassigned Sample task 9",
      "  ◌ #10 ↻8 @unassigned Sample task 10",
      "  ◌ #11 ↻8 @unassigned Sample task 11",
    ]);
    const positions = lines.slice(1).map((line) => line.indexOf("↻"));
    expect(new Set(positions).size).toBe(1);
  });

  it("aligns one/two/three-digit ids and sorts input", () => {
    const tasks = [
      task({ id: 100, subject: "c", maxAttempts: 8 }),
      task({ id: 7, subject: "a", maxAttempts: 8 }),
      task({ id: 80, subject: "b", maxAttempts: 8 }),
    ];
    const lines = buildWidgetLines(tasks, FIXED_NOW);
    expect(lines.slice(1)).toEqual([
      "  ◌ #7   ↻8 a",
      "  ◌ #80  ↻8 b",
      "  ◌ #100 ↻8 c",
    ]);
    expect(idColumnWidth(tasks)).toBe("#100".length);
  });

  it("preserves standalone formatTaskLine output by default with an opt-in width", () => {
    const single = task({ id: 9, subject: "Sample task 9", assignee: "unassigned", maxAttempts: 8 });
    expect(formatTaskLine(single, FIXED_NOW, assigneeConfig)).toBe("  ◌ #9 ↻8 @unassigned Sample task 9");
    expect(formatTaskLine(single, FIXED_NOW, assigneeConfig, "#10".length)).toBe(
      "  ◌ #9  ↻8 @unassigned Sample task 9",
    );
  });

  it("aligns themed lines without changing glyph styling or retry semantics", () => {
    const lines = renderWidgetLines(alignedTasks(), fakeTheme, undefined, true, FIXED_NOW, undefined, assigneeConfig);
    expect(lines[1]).toContain("<dim>#9  ↻8</>");
    expect(lines[2]).toContain("<dim>#10 ↻8</>");
    expect(lines[3]).toContain("<dim>#11 ↻8</>");
    expect(lines[1]).toMatch(/^  <dim>◌<\/>/);
    const positions = lines.slice(1).map((line) => visibleWidth(line.slice(0, line.indexOf("↻"))));
    expect(new Set(positions).size).toBe(1);
  });

  it("pads unlimited-task ids without adding a retry indicator", () => {
    expect(formatTaskLine(task({ id: 1, subject: "Free", maxAttempts: 0 }), FIXED_NOW)).toBe(
      "  ◌ #1 Free",
    );
    const lines = buildWidgetLines(
      [
        task({ id: 1, subject: "Free", maxAttempts: 0 }),
        task({ id: 10, subject: "Capped", maxAttempts: 8 }),
      ],
      FIXED_NOW,
    );
    expect(lines[1]).toBe("  ◌ #1     Free");
    expect(lines[2]).toBe("  ◌ #10 ↻8 Capped");
    expect(lines[1].indexOf("Free")).toBe(lines[2].indexOf("Capped"));
    const themed = renderWidgetLines(
      [
        task({ id: 1, subject: "Free", maxAttempts: 0 }),
        task({ id: 10, subject: "Capped", maxAttempts: 8 }),
      ],
      fakeTheme,
    );
    expect(themed[1]).toContain("<dim>#1    </>");
    expect(themed[1]).not.toContain("↻");
    expect(themed[2]).toContain("<dim>#10 ↻8</>");
  });

  it("still truncates aligned lines within width", () => {
    const lines = renderWidgetLines(alignedTasks(), fakeTheme, 24, true, undefined, undefined, assigneeConfig);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  });
});

describe("assignee column alignment", () => {
  it("left-aligns @assignee labels, reserves mixed-set gaps, and treats unassigned as a value", () => {
    const tasks = [
      task({ id: 1, subject: "Pending subject", assignee: "api" }),
      task({ id: 2, subject: "Active subject", assignee: "long-agent", status: "in_progress" }),
      task({ id: 3, subject: "Completed subject", status: "completed" }),
      task({ id: 4, subject: "Paused subject", assignee: "unassigned", status: "paused" }),
    ];
    expect(assigneeColumnWidth(tasks, assigneeConfig)).toBe("@long-agent".length);
    const lines = buildWidgetLines(tasks, FIXED_NOW, undefined, assigneeConfig).slice(1);
    expect(lines[0]).toContain("#1 ↻9 @api        Pending subject");
    expect(lines[1]).toContain("#2 ↻9 @long-agent Active subject");
    expect(lines[2]).toContain("#3 ↻9             Completed subject");
    expect(lines[3]).toContain("#4 ↻9 @unassigned Paused subject");
    const subjectPositions = lines.map((line, index) => line.indexOf(tasks[index].subject));
    expect(new Set(subjectPositions).size).toBe(1);
  });

  it("adds no assignee column when every task is truly unassigned", () => {
    const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" })];
    expect(assigneeColumnWidth(tasks)).toBe(0);
    expect(buildWidgetLines(tasks, FIXED_NOW).slice(1)).toEqual([
      "  ◌ #1 ↻9 a",
      "  ◌ #2 ↻9 b",
    ]);
  });

  it("styles each entire padded assignee field like its status subject", () => {
    const tasks = [
      task({ id: 1, subject: "a", assignee: "api" }),
      task({ id: 2, subject: "b", assignee: "long-agent", status: "in_progress" }),
      task({ id: 3, subject: "c", status: "completed" }),
      task({ id: 4, subject: "d", assignee: "unassigned", status: "paused" }),
    ];
    const lines = renderWidgetLines(tasks, fakeTheme, undefined, true, FIXED_NOW, undefined, assigneeConfig).slice(1);
    expect(lines[0]).toContain("<text>@api       </>");
    expect(lines[1]).toContain("<text>*@long-agent*</>");
    expect(lines[2]).toContain("<dim>           </>");
    expect(lines[3]).toContain("<text>@unassigned</>");
  });

  it("uses visible width for wide assignee labels and keeps standalone output unpadded", () => {
    const tasks = [
      task({ id: 1, subject: "a", assignee: "界" }),
      task({ id: 2, subject: "b", assignee: "api" }),
    ];
    expect(assigneeColumnWidth(tasks, assigneeConfig)).toBe(4);
    const lines = buildWidgetLines(tasks, FIXED_NOW, undefined, assigneeConfig).slice(1);
    expect(lines[0]).toContain("@界  a");
    expect(lines[1]).toContain("@api b");
    expect(formatTaskLine(tasks[0], FIXED_NOW, assigneeConfig)).toBe("  ◌ #1 ↻9 @界 a");
  });
});

describe("remaining-attempts column alignment", () => {
  it("left-aligns mixed remaining-attempts widths so following content starts consistently", () => {
    const tasks = [
      task({ id: 1, subject: "a", attempt: 0, maxAttempts: 8 }),
      task({ id: 2, subject: "b", attempt: 0, maxAttempts: 11 }),
      task({ id: 3, subject: "c", attempt: 0, maxAttempts: 101 }),
    ];
    expect(retryColumnWidth(tasks)).toBe("↻101".length);
    const lines = buildWidgetLines(tasks, FIXED_NOW);
    expect(lines.slice(1)).toEqual([
      "  ◌ #1 ↻8   a",
      "  ◌ #2 ↻11  b",
      "  ◌ #3 ↻101 c",
    ]);
    const positions = lines.slice(1).map((line) => line.indexOf("a") >= 0 ? line.indexOf("a") : line.indexOf("b") >= 0 ? line.indexOf("b") : line.indexOf("c"));
    expect(new Set(positions).size).toBe(1);
  });

  it("reserves remaining-attempts width as spaces for unlimited tasks in mixed sets", () => {
    const tasks = [
      task({ id: 1, subject: "Free", maxAttempts: 0 }),
      task({ id: 2, subject: "Capped", attempt: 0, maxAttempts: 11 }),
    ];
    expect(retryColumnWidth(tasks)).toBe("↻11".length);
    const lines = buildWidgetLines(tasks, FIXED_NOW);
    expect(lines[1]).toBe("  ◌ #1     Free");
    expect(lines[2]).toBe("  ◌ #2 ↻11 Capped");
    expect(lines[1].indexOf("Free")).toBe(lines[2].indexOf("Capped"));
    expect(lines[1]).not.toContain("↻");
  });

  it("adds no remaining-attempts column when all tasks are unlimited", () => {
    const tasks = [
      task({ id: 1, subject: "Free", maxAttempts: 0 }),
      task({ id: 10, subject: "Also free", maxAttempts: 0 }),
    ];
    expect(retryColumnWidth(tasks)).toBe(0);
    const lines = buildWidgetLines(tasks, FIXED_NOW);
    expect(lines.slice(1)).toEqual(["  ◌ #1  Free", "  ◌ #10 Also free"]);
    expect(lines[1].indexOf("Free")).toBe(lines[2].indexOf("Also free"));
  });

  it("aligns themed remaining-attempts columns without changing glyph styling", () => {
    const tasks = [
      task({ id: 1, subject: "a", attempt: 0, maxAttempts: 8 }),
      task({ id: 2, subject: "b", attempt: 0, maxAttempts: 101 }),
    ];
    const lines = renderWidgetLines(tasks, fakeTheme, undefined, true, FIXED_NOW);
    expect(lines[1]).toContain("<dim>#1 ↻8  </>");
    expect(lines[2]).toContain("<dim>#2 ↻101</>");
    expect(lines[1]).toMatch(/^  <dim>◌<\/>/);
    const widths = lines.slice(1).map((line) => visibleWidth(line.slice(0, line.indexOf("<text>"))));
    expect(new Set(widths).size).toBe(1);
  });

  it("preserves standalone output with opt-in remaining-attempts width", () => {
    const single = task({ id: 1, subject: "a", attempt: 0, maxAttempts: 8 });
    expect(formatTaskLine(single, FIXED_NOW)).toBe("  ◌ #1 ↻8 a");
    expect(formatTaskLine(single, FIXED_NOW, undefined, undefined, "↻101".length)).toBe(
      "  ◌ #1 ↻8   a",
    );
  });
});

describe("header format", () => {
  const SIX_M_37_S = 397_000;

  it("renders pending headers without duration in plain and themed output", () => {
    const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" })];
    expect(buildWidgetLines(tasks, FIXED_NOW)[0]).toBe("● Tasks · 2 total · 0 done");
    expect(renderWidgetLines(tasks, fakeTheme, undefined, true, FIXED_NOW)[0]).toBe(
      "<accent>● *Tasks*</><dim> · 2 total · 0 done</>",
    );
  });

  it("uses literal Tasks for a singular total", () => {
    expect(buildWidgetLines([task({ id: 1, subject: "a" })], FIXED_NOW)[0]).toBe(
      "● Tasks · 1 total · 0 done",
    );
    expect(renderWidgetLines([task({ id: 1, subject: "a" })], fakeTheme, undefined, true, FIXED_NOW)[0]).toBe(
      "<accent>● *Tasks*</><dim> · 1 total · 0 done</>",
    );
  });

  it("appends the active duration last once started", () => {
    const tasks = [
      task({ id: 1, subject: "a", status: "completed", attempt: 1, tookMs: 60_000 }),
      task({ id: 2, subject: "b", attempt: 1 }),
      task({ id: 3, subject: "c" }),
    ];
    expect(buildWidgetLines(tasks, FIXED_NOW, { totalActiveMs: SIX_M_37_S })[0]).toBe(
      "● Tasks · 3 total · 1 done · 6m 37s",
    );
    expect(renderWidgetLines(tasks, fakeTheme, undefined, true, FIXED_NOW, { totalActiveMs: SIX_M_37_S })[0]).toBe(
      "<accent>● *Tasks*</><dim> · 3 total · 1 done · 6m 37s</>",
    );
    const runningSince = new Date(FIXED_NOW - 5_000).toISOString();
    const running = [
      task({ id: 1, subject: "a", status: "in_progress", attempt: 1, startedAt: runningSince }),
    ];
    expect(
      buildWidgetLines(running, FIXED_NOW, { totalActiveMs: 60_000, activeSince: runningSince })[0],
    ).toBe("● Tasks · 1 total · 0 done · 1m 5s");
  });

  it("renders completed headers with duration only after a start", () => {
    expect(
      buildWidgetLines([task({ id: 1, subject: "a", status: "completed", tookMs: 5_000 })], FIXED_NOW)[0],
    ).toBe("● Tasks · 1 total · 1 done");
    expect(
      buildWidgetLines(
        [task({ id: 1, subject: "a", status: "completed", attempt: 1, tookMs: SIX_M_37_S })],
        FIXED_NOW,
        { totalActiveMs: SIX_M_37_S },
      )[0],
    ).toBe("● Tasks · 1 total · 1 done · 6m 37s");
  });

  it("appends paused only when pauses exist, keeping duration last", () => {
    const withoutPause = [
      task({ id: 1, subject: "a", status: "completed", attempt: 1, tookMs: 1_000 }),
      task({ id: 2, subject: "b" }),
    ];
    expect(buildWidgetLines(withoutPause, FIXED_NOW, { totalActiveMs: SIX_M_37_S })[0]).toBe(
      "● Tasks · 2 total · 1 done · 6m 37s",
    );
    const withPause = [
      task({ id: 1, subject: "a", status: "completed", attempt: 1, tookMs: 1_000 }),
      task({ id: 2, subject: "b", status: "paused", attempt: 1, tookMs: 2_000 }),
      task({ id: 3, subject: "c" }),
    ];
    expect(buildWidgetLines(withPause, FIXED_NOW, { totalActiveMs: SIX_M_37_S })[0]).toBe(
      "● Tasks · 3 total · 1 done · 1 paused · 6m 37s",
    );
    expect(renderWidgetLines(withPause, fakeTheme, undefined, true, FIXED_NOW, { totalActiveMs: SIX_M_37_S })[0]).toBe(
      "<accent>● *Tasks*</><dim> · 3 total · 1 done · 1 paused · 6m 37s</>",
    );
  });

  it("bolds only Tasks and keeps duration dim", () => {
    const tasks = [
      task({ id: 1, subject: "a", status: "completed", attempt: 1, tookMs: 1_000 }),
      task({ id: 2, subject: "b", status: "paused", attempt: 1, tookMs: 2_000 }),
      task({ id: 3, subject: "c" }),
    ];
    const themed = renderWidgetLines(tasks, fakeTheme, undefined, true, FIXED_NOW, { totalActiveMs: SIX_M_37_S })[0];
    expect(themed).toBe("<accent>● *Tasks*</><dim> · 3 total · 1 done · 1 paused · 6m 37s</>");
    expect(themed).toContain("<accent>● *Tasks*</>");
    expect(themed).toContain("<dim> · 3 total · 1 done · 1 paused · 6m 37s</>");
    expect(themed).not.toContain("*3 total*");
    expect(themed).not.toContain("*1 done*");
    expect(themed).not.toContain("*1 paused*");
    expect(themed).not.toContain("*6m 37s*");

    const pending = renderWidgetLines(
      [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" })],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    )[0];
    expect(pending).toBe("<accent>● *Tasks*</><dim> · 2 total · 0 done</>");
    expect(pending).toContain("<accent>● *Tasks*</>");
    expect(pending).toContain("<dim> · 2 total · 0 done</>");
    expect(pending).toContain("*Tasks*");
    expect(pending).not.toContain("*2 total*");
    expect(pending).not.toContain("*0 done*");

    const pausedOnly = renderWidgetLines(
      [
        task({ id: 1, subject: "a", status: "completed", tookMs: 1_000 }),
        task({ id: 2, subject: "b", status: "paused", tookMs: 2_000 }),
        task({ id: 3, subject: "c" }),
      ],
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    )[0];
    expect(pausedOnly).toBe("<accent>● *Tasks*</><dim> · 3 total · 1 done · 1 paused</>");
    expect(pausedOnly).toContain("<accent>● *Tasks*</>");
    expect(pausedOnly).toContain("<dim> · 3 total · 1 done · 1 paused</>");
    expect(pausedOnly).toContain("*Tasks*");
    expect(pausedOnly).not.toContain("*3 total*");
    expect(pausedOnly).not.toContain("*1 done*");
    expect(pausedOnly).not.toContain("*1 paused*");

    const timed = renderWidgetLines(tasks, fakeTheme, undefined, true, FIXED_NOW, { totalActiveMs: SIX_M_37_S })[0];
    expect(timed).toBe("<accent>● *Tasks*</><dim> · 3 total · 1 done · 1 paused · 6m 37s</>");
    expect(timed).toContain("<accent>● *Tasks*</>");
    expect(timed).toContain("<dim> · 3 total · 1 done · 1 paused · 6m 37s</>");
    expect(timed).toContain("*Tasks*");
    expect(timed).not.toContain("*3 total*");
    expect(timed).not.toContain("*1 done*");
    expect(timed).not.toContain("*1 paused*");
    expect(timed).not.toContain("*6m 37s*");
  });
});
