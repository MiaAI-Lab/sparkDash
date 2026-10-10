/**
 * The time zone the charts use. "" / null follows the viewer's browser (the old
 * behaviour); otherwise an IANA name from Settings. A module-level value because
 * the stats helpers are plain functions; App re-keys the page when it changes.
 */
let configured: string | null = null;

export function isValidTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || !name.trim() || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name.trim() });
    return true;
  } catch {
    return false;
  }
}

export function setConfiguredTimeZone(name: string | null | undefined): void {
  configured = isValidTimeZone(name) ? name.trim() : null;
}

export function configuredTimeZone(): string | null {
  return configured;
}

/** The zone in effect: the setting, else the browser's. */
export function activeTimeZone(): string {
  return configured ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes east of UTC for `tz` at the instant `ms` (e.g. +120 for CEST, +330 for India). */
export function tzOffsetMinutes(ms: number, tz?: string | null): number {
  if (!tz && configured == null) return -new Date(ms).getTimezoneOffset();
  const zone = tz || configured!;
  let f = offsetFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    offsetFormatters.set(zone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  // Compare against the instant truncated to the second, which is what the parts describe.
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** All zone names the browser knows, for the Settings suggestions. */
export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const names = intl.supportedValuesOf?.("timeZone") ?? [];
  return names.includes("UTC") ? names : ["UTC", ...names];
}
