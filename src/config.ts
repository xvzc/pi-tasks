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
  /** Glyph character rendered for this status. Must be printable on one line with positive visible width. */
  character: string;
  /** Default glyph color name, resolved through the theme mapping. Must be a non-empty string. */
  defaultColor: string;
}

export interface PiTasksConfig {
  /**
   * Default per-task attempt cap used when TaskCreate omits maxAttempts.
   * Always a non-negative safe integer; 0 means unlimited attempts.
   */
  defaultMaxAttempts: number;
  glyphs: {
    inProgress: StatusGlyphConfig;
    pending: StatusGlyphConfig;
    completed: StatusGlyphConfig;
  };
}

export type GlyphStatusKey = keyof PiTasksConfig["glyphs"];

/** Centralized defaults: 9 attempts, filled glyphs, green/grey/green defaults. */
export const DEFAULT_CONFIG: PiTasksConfig = {
  defaultMaxAttempts: 9,
  glyphs: {
    inProgress: { character: "■", defaultColor: "green" },
    pending: { character: "■", defaultColor: "grey" },
    completed: { character: "■", defaultColor: "green" },
  },
};

const GLYPH_KEYS: GlyphStatusKey[] = ["inProgress", "pending", "completed"];

const ROOT_KEYS = new Set(["defaultMaxAttempts", "glyphs"]);
const GLYPHS_KEYS = new Set<string>(GLYPH_KEYS);
const GLYPH_FIELD_KEYS = new Set(["character", "defaultColor"]);

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
    defaultMaxAttempts: config.defaultMaxAttempts,
    glyphs: {
      inProgress: { ...config.glyphs.inProgress },
      pending: { ...config.glyphs.pending },
      completed: { ...config.glyphs.completed },
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

  if (data.defaultMaxAttempts !== undefined) {
    if (
      typeof data.defaultMaxAttempts === "number" &&
      Number.isSafeInteger(data.defaultMaxAttempts) &&
      data.defaultMaxAttempts >= 0
    ) {
      config.defaultMaxAttempts = data.defaultMaxAttempts;
    } else {
      warn(
        `pi-tasks: invalid config at ${configPath}, using default defaultMaxAttempts (${DEFAULT_CONFIG.defaultMaxAttempts}): expected a non-negative safe integer, got ${JSON.stringify(data.defaultMaxAttempts)}.`,
      );
    }
  }

  if (data.glyphs !== undefined) {
    if (!isRecord(data.glyphs)) {
      warn(`pi-tasks: invalid config at ${configPath}, using default glyphs: expected glyphs to be an object.`);
    } else {
      for (const key of Object.keys(data.glyphs)) {
        if (!GLYPHS_KEYS.has(key)) {
          warn(`pi-tasks: unknown config glyph "${key}" at ${configPath}, ignoring.`);
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
          if (!GLYPH_FIELD_KEYS.has(field)) {
            warn(`pi-tasks: unknown config key "glyphs.${key}.${field}" at ${configPath}, ignoring.`);
          }
        }
        if (glyph.character !== undefined) {
          if (typeof glyph.character === "string" && isValidGlyphCharacter(glyph.character)) {
            config.glyphs[key].character = glyph.character;
          } else {
            warn(
              `pi-tasks: invalid config at ${configPath}, using default glyphs.${key}.character ("${fallback.character}"): expected a printable glyph with positive visible width and no line breaks.`,
            );
          }
        }
        if (glyph.defaultColor !== undefined) {
          if (typeof glyph.defaultColor === "string" && glyph.defaultColor.trim().length > 0) {
            config.glyphs[key].defaultColor = glyph.defaultColor;
          } else {
            warn(
              `pi-tasks: invalid config at ${configPath}, using default glyphs.${key}.defaultColor ("${fallback.defaultColor}"): expected a non-empty string.`,
            );
          }
        }
      }
    }
  }

  return config;
}
