export const MINUTES_PER_DAY: 1440;
export const DAY_TYPES: readonly ["weekday", "weekend"];

export type DayType = "weekday" | "weekend";

/** Raw window as persisted/typed: 24-hour "HH:MM" strings. */
export interface RawWindow {
  start?: unknown;
  end?: unknown;
}

/** Canonicalized window with derived coverage data. */
export interface ScheduleWindow {
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  /** true when end <= start (covers the midnight seam) */
  wrap: boolean;
  /** true when start === end (whole day) */
  fullDay: boolean;
  key: string;
  label: string;
  owner: string | null;
  /** Disjoint half-open [start,end) pieces on [0,1440). */
  spans: [number, number][];
}

/** Per-model schedule as persisted on the model record. */
export interface ModelSchedule {
  enabled: boolean;
  weekday: { start: string; end: string }[];
  weekend: { start: string; end: string }[];
}

export interface SchedulerConfig {
  enabled: boolean;
  tz: string;
}

export interface ZonedParts {
  /** wall-clock minute of day, 0..1439 */
  minute: number;
  dayType: DayType;
  /** YYYY-MM-DD in the zone */
  dateKey: string;
  weekday: string;
  /** wall − UTC, in minutes (DST-aware) */
  offsetMin: number;
}

export function parseClock(value: unknown): number | null;
export function formatClock(minute: number): string;

export function normalizeWindow(
  raw: RawWindow | null | undefined,
  owner?: string | null
): ScheduleWindow | null;

export function normalizeWindowList(
  list: unknown,
  owner?: string | null
): { windows: ScheduleWindow[]; errors: string[] };

export function windowCovers(
  w: Pick<ScheduleWindow, "startMin" | "endMin" | "wrap" | "fullDay"> | null | undefined,
  minute: number
): boolean;

export function findWindowOverlaps(windows: ScheduleWindow[]): [ScheduleWindow, ScheduleWindow][];

export function validateWindows(
  list: unknown,
  owner?: string | null
): { ok: boolean; windows: ScheduleWindow[]; errors: string[] };

export function findScheduleConflicts(
  entries: Iterable<{
    id: string;
    name?: string;
    windows?: ScheduleWindow[];
    weekday?: ScheduleWindow[];
    weekend?: ScheduleWindow[];
  }>
): string[];

export function resolveActiveWindow(
  windows: ScheduleWindow[] | null | undefined,
  minute: number
): ScheduleWindow | null;

export function nextBoundary(
  windows: ScheduleWindow[] | null | undefined,
  minute: number
): { minute: number; minutesUntil: number } | null;

export function scheduleWindows(schedule: ModelSchedule | null | undefined, dayType: DayType): ScheduleWindow[];

export function zonedParts(date: Date | number, tz: string): ZonedParts;

export function dayTypeOf(date: Date | number, tz: string): DayType;

export function zonedMinuteToEpoch(date: Date | number, tz: string, targetMinute: number): number;

export function nextBoundaryAt(
  date: Date | number,
  tz: string,
  windows: ScheduleWindow[] | null | undefined
): { epochMs: number; minute: number; minutesUntil: number } | null;

export function normalizeSchedulerConfig(raw: unknown): SchedulerConfig;

export function normalizeModelSchedule(raw: unknown): ModelSchedule;

export function scheduleIsUsable(schedule: ModelSchedule | null | undefined): boolean;

export function validateModelSchedule(raw: unknown): {
  ok: boolean;
  errors: string[];
  schedule: ModelSchedule;
  weekdayWindows: ScheduleWindow[];
  weekendWindows: ScheduleWindow[];
};
