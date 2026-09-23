/** Shared task model and persisted store envelope. */

export type TaskStatus = "pending" | "in_progress" | "paused" | "completed" | "deleted";

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
  /** Assigned agent type shown as `@assignee` in the widget. */
  assignee?: string;
  status: TaskStatus;
  /** Number of entries into `in_progress`. Starts at 0, increments on every non-`in_progress` -> `in_progress` (including `paused` resumes and `completed` rework). */
  attempt: number;
  /** Per-task immutable cap for `attempt`. Defaults to the configured maxAttempts (8 unless configured). 0 means unlimited attempts. */
  maxAttempts: number;
  /** IDs this task depends on. Defaults to []. */
  blockedBy: number[];
  /** IDs of writer tasks this task reviews. Defaults to []. */
  reviewOf: number[];
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
  /** Frozen duration in integer milliseconds of the last finished attempt. Set on transition into `completed`, `paused`, or `deleted`; cleared on entry into `in_progress`; preserved otherwise. Absent until the first finish. */
  tookMs?: number;
}

/** One immutable completed/deleted terminal cycle retained in the version-2 envelope. */
export interface TaskHistoryCycle {
  /** ISO 8601 UTC timestamp at which the completed cycle left the active list. */
  archivedAt: string;
  /** Completed task snapshots, including metadata and execution logs. */
  tasks: Task[];
  /** Wall-clock union milliseconds accumulated by this cycle. */
  totalActiveMs: number;
}

/** On-disk version-2 envelope. Version-1 envelopes remain readable. */
export interface StoreData {
  version: 2;
  nextId: number;
  tasks: Task[];
  /** Append-only terminal-cycle history. */
  history: TaskHistoryCycle[];
  /** Wall-clock union milliseconds accumulated while at least one active task was `in_progress`. Finished periods only; the running period (if any) starts at `activeSince`. */
  totalActiveMs: number;
  /** ISO 8601 UTC start of the current active period. Present iff at least one task is `in_progress`. */
  activeSince?: string;
}

export const TASK_STATUSES: TaskStatus[] = ["pending", "in_progress", "paused", "completed", "deleted"];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "paused" || value === "completed" || value === "deleted";
}

/**
 * Single immutable source of truth for real status transitions.
 * Same-status patches are always allowed and are not transitions.
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["in_progress", "deleted"],
  in_progress: ["paused", "completed"],
  paused: ["in_progress", "deleted"],
  completed: ["in_progress"],
  deleted: [],
};
