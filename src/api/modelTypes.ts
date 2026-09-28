/**
 * Model launcher types — mirrored from server/models (ModelRegistry /
 * ModelJobManager / ModelScheduler). Kept in their own file so the feature can
 * be merged/removed without touching the Spark type surface.
 */
import type { DayType, ModelSchedule } from "../shared/modelSchedules";

export type ModelAction = "start" | "stop" | "restart" | "logs";
export type ModelJobStatus = "running" | "done" | "cancelled" | "timeout" | "error";
export type JobSource = "manual" | "scheduler";

export interface ModelStatus {
  running: boolean;
  /** null when the container could not be checked (docker unavailable) */
  containerUp: boolean | null;
  /** null when no port is configured */
  portUp: boolean | null;
  /**
   * false when :port was deliberately NOT asked this tick — a confirmed
   * container already settles the answer (only one model can run, so the
   * owner's container proves both who is up and who is not).
   */
  portChecked?: boolean;
  modelId: string | null;
  error: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Absolute path of the repo ON `sparkId` (validated inside the repos base). */
  dir: string;
  /** Spark whose machine runs the scripts (null = unassigned → no actions). */
  sparkId: string | null;
  /** Display name of the assigned Spark; equals sparkId when it was removed. */
  sparkName: string | null;
  description: string | null;
  container: string | null;
  port: number | null;
  /** 1-based card position in the Overview list (registry keeps 1..n). */
  position: number | null;
  apiPath: string | null;
  /** GitHub URL for the kit (auto-detected from `git remote`, editable). */
  repoUrl: string | null;
  hasLogs: boolean;
  canRestart: boolean;
  startArgs: string[] | null;
  schedule: ModelSchedule;
  status: ModelStatus;
  /** Newest job for this model (running or last finished), or null. */
  job: ModelJob | null;
}

/** Editable model config (POST/PUT body). */
export interface ModelConfig {
  id: string;
  name?: string;
  dir: string;
  /** Target Spark id for scripts/probes — set in the card's edit dialog. */
  sparkId?: string | null;
  description?: string | null;
  startScript: string;
  stopScript: string;
  restartScript?: string | null;
  logsScript?: string | null;
  startArgs?: string[];
  container?: string | null;
  port?: number | null;
  /** 1-based card position; omit to append at the end. */
  position?: number | null;
  apiPath?: string | null;
  /** https browse URL for the kit; auto-detected when omitted. */
  repoUrl?: string | null;
  schedule?: ModelSchedule;
}

/**
 * Job snapshot as returned by GET /api/models/jobs/:id. `append` is the
 * transcript delta since `since`; `reset` means the cursor fell behind the
 * ring buffer and the client should clear what it has.
 */
export interface ModelJob {
  jobId: string;
  modelId: string;
  model: string;
  action: ModelAction;
  status: ModelJobStatus;
  script: string | null;
  dir: string | null;
  source: JobSource;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  timedOut: boolean;
  totalChars: number;
  truncated: boolean;
  killed: boolean;
  append?: string;
  reset?: boolean;
  since?: number;
}

export interface SchedulerWindowInfo {
  start: string;
  end: string;
  label: string;
  owner: string | null;
}

export interface SchedulerStatus {
  enabled: boolean;
  tz?: string;
  dayType?: DayType;
  window: SchedulerWindowInfo | null;
  activeModelId: string | null;
  /** The model the schedule switches to at the upcoming boundary (null = gap). */
  nextModelId?: string | null;
  /** The window that owns that next model (null when nothing follows). */
  nextWindow?: SchedulerWindowInfo | null;
  override: { modelId: string | null } | null;
  /** Absolute epoch ms — stable between boundaries (payload stays byte-stable). */
  nextBoundary: { epochMs: number; clock: string } | null;
  lastDecision: { action: string; modelId?: string; reason?: string } | null;
}

export interface SchedulerConfig {
  enabled: boolean;
  tz: string;
}

/** The `models` block on every WS snapshot. */
export interface ModelsSnapshot {
  models: ModelInfo[];
  activeJob: ModelJob | null;
  scheduler: SchedulerStatus;
}

export interface ModelActionResponse {
  jobId: string;
  status: string;
  stopping?: string[];
  stoppingJobIds?: string[];
}

export interface SchedulerPreview {
  at: number;
  tz: string;
  dayType: DayType;
  clock: string;
  enabled: boolean;
  activeWindow: { start: string; end: string; label: string; modelId: string; modelName: string } | null;
  conflicts: string[];
  nextBoundary: { epochMs: number; minute: number; minutesUntil: number } | null;
  plan: { id: string; name: string; windows: string[] }[];
}
