/** Shared task model and persisted store envelope. */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskLogEntry {
  /** ISO 8601 UTC timestamp added by the store. */
  timestamp: string;
  /** Caller-supplied execution note. */
  message: string;
}

export interface Task {
  /** Numeric, positive, monotonically allocated within a store. Never reused. */
  id: number;
  subject: string;
  description: string;
  /** Assigned agent type shown as `[assignee]` in the widget. */
  assignee?: string;
  /** Optional accent color name for the status glyph. Never interpreted by the store. */
  color?: string;
  status: TaskStatus;
  /** Number of entries into `in_progress`. Starts at 0, increments on pending/completed -> in_progress. */
  attempt: number;
  /** Per-task immutable cap for `attempt`. Defaults to the configured defaultMaxAttempts (9 unless configured). 0 means unlimited attempts. */
  maxAttempts: number;
  /** IDs this task depends on. Defaults to []. */
  blockedBy: number[];
  /** Free-form agent metadata. Updated with shallow merge. Defaults to {}. */
  metadata: Record<string, unknown>;
  /** Append-only timestamped execution notes. Defaults to []. */
  log: TaskLogEntry[];
  /** ISO 8601 UTC timestamp. Set once at creation, never changed. */
  createdAt: string;
  /** ISO 8601 UTC timestamp. Refreshed on every successful update. */
  updatedAt: string;
  /** ISO 8601 UTC timestamp marking the start of the current `in_progress` attempt. Set only on a real non-`in_progress` -> `in_progress` transition; preserved by `in_progress` -> `in_progress` updates; cleared when leaving `in_progress`. Absent on legacy persisted tasks (initialized to the load timestamp on load, so the attempt starts at zero). */
  startedAt?: string;
  /** Frozen duration in integer milliseconds of the last completed attempt. Set on transition into `completed`; cleared on entry into `in_progress`; preserved otherwise. Absent until the first completion. */
  tookMs?: number;
}

/** On-disk envelope. `version` is always 1. */
export interface StoreData {
  version: 1;
  nextId: number;
  tasks: Task[];
  /** Wall-clock union milliseconds accumulated while at least one task was `in_progress`. Finished periods only; the running period (if any) starts at `activeSince`. Defaults to 0 for legacy files. */
  totalActiveMs: number;
  /** ISO 8601 UTC start of the current active period. Present iff at least one task is `in_progress`. */
  activeSince?: string;
}

export const TASK_STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}
