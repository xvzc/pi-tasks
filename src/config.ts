/**
 * pi-tasks configuration.
 *
 * Loaded once from `join(getAgentDir(), "extensions", "pi-tasks.json")`
 * (i.e. `$PI_CODING_AGENT_DIR/extensions/pi-tasks.json`) when the extension
 * registers. A missing file or missing fields fall back to {@link DEFAULT_CONFIG};
 * malformed JSON or invalid fields warn (via the supplied warn callback) and
 * fall back safely for just the offending value, never crashing startup.
 * Partial nested `glyphs` objects merge with the defaults per glyph/field.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export interface StatusGlyphConfig {
  /** Legacy glyph override for this status. */
  character: string;
}

export interface InProgressGlyphConfig extends StatusGlyphConfig {
  frames: string[];
}

export interface PendingGlyphConfig extends StatusGlyphConfig {
  retriedCharacter: string;
}

export interface CompletedGlyphConfig extends StatusGlyphConfig {
  awaitingReviewCharacter: string;
}

export interface PiTasksConfig {
  /**
   * Per-task attempt cap used when task_create creates a task.
   * Always a non-negative safe integer; 0 means unlimited attempts.
   */
  maxAttempts: number;
  /**
   * Whether assignee input, prompt guidance, and assignee display are
   * enabled. Defaults to false (assignee hidden in human-facing
   * prompt/schema/UI surfaces while persisted data stays intact).
   */
  enableAssignee: boolean;
  glyphs: {
    inProgress: InProgressGlyphConfig;
    pending: PendingGlyphConfig;
    completed: CompletedGlyphConfig;
    paused: StatusGlyphConfig;
    deleted: StatusGlyphConfig;
  };
}

export type GlyphStatusKey = keyof PiTasksConfig["glyphs"];

/** Centralized defaults. Glyph colors are fixed in the widget (see src/widget.ts). */
export const DEFAULT_CONFIG: PiTasksConfig = {
  maxAttempts: 8,
  enableAssignee: false,
  glyphs: {
    inProgress: { character: "◌", frames: ["◌", "○", "⨀", "◉", "●", "◉", "⨀", "○", "◌"] },
    pending: { character: "◌", retriedCharacter: "■" },
    completed: { character: "●", awaitingReviewCharacter: "○" },
    paused: { character: "⏸" },
    deleted: { character: "⌫" },
  },
};

/**
 * Attempt-limit bounds for newly configured/created tasks. There is no hard
 * upper cap: `maxAttempts` accepts any non-negative safe integer
 * (0 means unlimited). Persisted records load unchanged under the same
 * non-negative safe-integer rule; the widget renders their exact remaining-attempt count.
 */

const GLYPH_KEYS: GlyphStatusKey[] = ["inProgress", "pending", "completed", "paused", "deleted"];

const ROOT_KEYS = new Set(["maxAttempts", "enableAssignee", "glyphs"]);
const GLYPHS_KEYS = new Set<string>(GLYPH_KEYS);
const GLYPH_FIELD_KEYS: Record<GlyphStatusKey, Set<string>> = {
  inProgress: new Set(["character", "frames"]),
  pending: new Set(["character", "retriedCharacter"]),
  completed: new Set(["character", "awaitingReviewCharacter"]),
  paused: new Set(["character"]),
  deleted: new Set(["character"]),
};

/**
 * A glyph character must be printable on one line: no line breaks, not
 * control-only content, and positive visible width. Multi-character and
 * wide printable glyphs are permitted (blink width support is intentional).
 */
function isValidGlyphCharacter(value: string): boolean {
  if (value.length === 0) return false;
  if (/[\r\n\u2028\u2029]/.test(value)) return false;
  if (/^[\p{Cc}\p{Cf}]+$/u.test(value)) return false;
  return visibleWidth(value) > 0;
}

/** Resolve the config file path for an agent dir (defaults to `getAgentDir()`). */
export function configFilePath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", "pi-tasks.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: PiTasksConfig): PiTasksConfig {
  return {
    maxAttempts: config.maxAttempts,
    enableAssignee: config.enableAssignee,
    glyphs: {
      inProgress: { ...config.glyphs.inProgress, frames: [...config.glyphs.inProgress.frames] },
      pending: { ...config.glyphs.pending },
      completed: { ...config.glyphs.completed },
      paused: { ...config.glyphs.paused },
      deleted: { ...config.glyphs.deleted },
    },
  };
}

/**
 * Load the pi-tasks config. Never throws for missing/malformed/invalid
 * files: warns per problem and falls back to {@link DEFAULT_CONFIG} values.
 */
export function loadPiTasksConfig(
  configPath: string = configFilePath(),
  warn: (message: string) => void = (message) => console.warn(message),
): PiTasksConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isRecord(error) && typeof error.code === "string" && error.code === "ENOENT") return config;
    warn(`pi-tasks: cannot read config at ${configPath}, using defaults: ${error instanceof Error ? error.message : String(error)}.`);
    return config;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    warn(`pi-tasks: invalid JSON in config at ${configPath}, using defaults: ${error instanceof Error ? error.message : String(error)}.`);
    return config;
  }
  if (!isRecord(data)) {
    warn(`pi-tasks: invalid config at ${configPath}, using defaults: expected an object.`);
    return config;
  }

  for (const key of Object.keys(data)) {
    if (!ROOT_KEYS.has(key)) {
      warn(`pi-tasks: unknown config key "${key}" at ${configPath}, ignoring.`);
    }
  }

  if (data.maxAttempts !== undefined) {
    if (
      typeof data.maxAttempts === "number" &&
      Number.isSafeInteger(data.maxAttempts) &&
      data.maxAttempts >= 0 &&
      data.maxAttempts <= Number.MAX_SAFE_INTEGER
    ) {
      config.maxAttempts = data.maxAttempts;
    } else {
      warn(
        `pi-tasks: invalid config at ${configPath}, using default maxAttempts (${DEFAULT_CONFIG.maxAttempts}): expected a non-negative safe integer (0 means unlimited), got ${JSON.stringify(data.maxAttempts)}.`,
      );
    }
  }

  if (data.enableAssignee !== undefined) {
    if (typeof data.enableAssignee === "boolean") {
      config.enableAssignee = data.enableAssignee;
    } else {
      warn(
        `pi-tasks: invalid config at ${configPath}, using default enableAssignee (${DEFAULT_CONFIG.enableAssignee}): expected a boolean, got ${JSON.stringify(data.enableAssignee)}.`,
      );
    }
  }

  if (data.glyphs !== undefined) {
    if (!isRecord(data.glyphs)) {
      warn(`pi-tasks: invalid config at ${configPath}, using default glyphs: expected glyphs to be an object.`);
    } else {
      for (const key of Object.keys(data.glyphs)) {
        if (!GLYPHS_KEYS.has(key as never) && key !== "failed") {
          warn(`pi-tasks: unknown config glyph "${key}" at ${configPath}, ignoring.`);
        } else if (key === "failed") {
          warn(`pi-tasks: legacy config glyph "failed" at ${configPath} is mapped to "paused"; rename it.`);
          const legacy = (data.glyphs as Record<string, unknown>).failed;
          if (isRecord(legacy) && typeof legacy.character === "string" && isValidGlyphCharacter(legacy.character) && (data.glyphs as Record<string, unknown>).paused === undefined) {
            config.glyphs.paused.character = legacy.character;
          }
        }
      }
      for (const key of GLYPH_KEYS) {
        const fallback = DEFAULT_CONFIG.glyphs[key];
        const glyph = data.glyphs[key];
        if (glyph === undefined) continue;
        if (!isRecord(glyph)) {
          warn(`pi-tasks: invalid config at ${configPath}, using default glyphs.${key}: expected an object.`);
          continue;
        }
        for (const field of Object.keys(glyph)) {
          if (!GLYPH_FIELD_KEYS[key].has(field)) {
            warn(`pi-tasks: unknown config key "glyphs.${key}.${field}" at ${configPath}, ignoring.`);
          }
        }
        let validCharacter = false;
        if (glyph.character !== undefined) {
          if (typeof glyph.character === "string" && isValidGlyphCharacter(glyph.character)) {
            config.glyphs[key].character = glyph.character;
            validCharacter = true;
          } else {
            warn(
              `pi-tasks: invalid config at ${configPath}, using default glyphs.${key}.character ("${fallback.character}"): expected a printable glyph with positive visible width and no line breaks.`,
            );
          }
        }
        if (key === "pending" && glyph.retriedCharacter !== undefined) {
          if (typeof glyph.retriedCharacter === "string" && isValidGlyphCharacter(glyph.retriedCharacter)) {
            config.glyphs.pending.retriedCharacter = glyph.retriedCharacter;
          } else {
            warn(
              `pi-tasks: invalid config at ${configPath}, using default glyphs.pending.retriedCharacter ("${DEFAULT_CONFIG.glyphs.pending.retriedCharacter}"): expected a printable glyph with positive visible width and no line breaks.`,
            );
          }
        }
        if (key === "completed" && glyph.awaitingReviewCharacter !== undefined) {
          if (typeof glyph.awaitingReviewCharacter === "string" && isValidGlyphCharacter(glyph.awaitingReviewCharacter)) {
            config.glyphs.completed.awaitingReviewCharacter = glyph.awaitingReviewCharacter;
          } else {
            warn(
              `pi-tasks: invalid config at ${configPath}, using default glyphs.completed.awaitingReviewCharacter ("${DEFAULT_CONFIG.glyphs.completed.awaitingReviewCharacter}"): expected a printable glyph with positive visible width and no line breaks.`,
            );
          }
        }
        if (key === "inProgress" && glyph.frames !== undefined) {
          const frames = glyph.frames;
          if (
            Array.isArray(frames) &&
            frames.length > 0 &&
            frames.every((frame) => typeof frame === "string" && isValidGlyphCharacter(frame)) &&
            frames.every((frame) => visibleWidth(frame as string) === visibleWidth(frames[0] as string))
          ) {
            config.glyphs.inProgress.frames = [...frames] as string[];
          } else {
            warn(
              `pi-tasks: invalid config at ${configPath}, using default glyphs.inProgress.frames: expected a non-empty array of printable, equal-width glyphs with positive visible width and no line breaks.`,
            );
          }
        }
        if (
          key === "pending" &&
          validCharacter &&
          !Object.prototype.hasOwnProperty.call(glyph, "retriedCharacter")
        ) {
          config.glyphs.pending.retriedCharacter = config.glyphs.pending.character;
        }
        if (
          key === "completed" &&
          validCharacter &&
          !Object.prototype.hasOwnProperty.call(glyph, "awaitingReviewCharacter")
        ) {
          config.glyphs.completed.awaitingReviewCharacter = config.glyphs.completed.character;
        }
        if (
          key === "inProgress" &&
          validCharacter &&
          !Object.prototype.hasOwnProperty.call(glyph, "frames")
        ) {
          const character = config.glyphs.inProgress.character;
          config.glyphs.inProgress.frames = [
            character,
            " ".repeat(Math.max(1, visibleWidth(character))),
          ];
        }
      }
    }
  }

  return config;
}
