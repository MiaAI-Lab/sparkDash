import type {
  DelegationDeskStatus,
  DeskOverride,
  DeskQuotaWindow,
  DeskRoute,
  DeskSignal,
} from "../../api/types";

/** How long a budget override lasts at the desk before it expires. */
export const OVERRIDE_HOURS = 4;
/** The desk treats a cloud route as full below this percent left on any window. */
export const QUOTA_CUTOFF = 10;

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** "3h 05m", "2d 4h", "12m"; "now" once it has passed. */
export function timeLeft(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${Math.max(m, 1)}m`;
}

export function ago(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "age unknown";
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

/** The model id without its endpoint prefix: "qualitycorp-oq/DeepSeek-V4" → "DeepSeek-V4". */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Local routes report sparkDash saturation; everything else is judged on quota. */
export function isLocal(route: DeskRoute): boolean {
  return route.signal?.kind === "saturation";
}

/** Display name: a local route is named after its sparkDash unit, a cloud route after its model. */
export function routeName(route: DeskRoute, unitNames: Record<string, string> = {}): string {
  const unit = route.signal?.unit;
  if (isLocal(route) && unit) return unitNames[unit] ?? unit;
  return isLocal(route) ? route.key : route.model;
}

export function rosterBudget(route: DeskRoute): number | null {
  return route.roster_budget !== undefined ? route.roster_budget : route.budget;
}

export interface LocalReading {
  state: string;
  age: number | null;
  /** null = the source did not report it. */
  running: number | null;
  waiting: number | null;
  kvPercent: number | null;
  /** The desk has a current sparkDash reading for this unit. */
  confirmed: boolean;
}

function fromDetail(detail: string, pattern: RegExp): number | null {
  const match = pattern.exec(detail);
  return match ? finite(Number(match[1])) : null;
}

/** Read a saturation signal without inventing values: anything unreported stays null. */
export function localReading(signal: DeskSignal | null | undefined): LocalReading {
  const state = signal?.state ?? "no-signal";
  const detail = signal?.detail ?? "";
  const live = state !== "no-signal";
  const waiting = finite(signal?.waiting)
    ?? fromDetail(detail, /\bwaiting (\d+(?:\.\d+)?)/)
    ?? fromDetail(detail, /(\d+(?:\.\d+)?) requests waiting/);
  const kv = finite(signal?.kv) ?? fromDetail(detail, /KV cache (\d+(?:\.\d+)?)/);
  return {
    state,
    age: finite(signal?.age),
    running: live ? finite(signal?.running) : null,
    waiting: live ? waiting : null,
    kvPercent: live && kv != null ? Math.round(kv * 100) : null,
    confirmed: state === "room" || state === "saturated",
  };
}

export type Tone = "free" | "muted" | "warn";

export interface Verdict {
  tone: Tone;
  text: string;
}

/**
 * One line on what the desk will do with the next request for this route.
 * `state` is the route's signal state; `confirmed` is false when no live reading backs it.
 */
export function slotVerdict(load: number, budget: number, reading: { state: string; confirmed: boolean; running: number | null }): Verdict {
  const free = budget - load;
  if (reading.state === "unavailable") return { tone: "muted", text: "Server down · new work skips it" };
  if (budget === 0) return { tone: "muted", text: "Paused · running work continues, new work skips it" };
  if (load > budget) return { tone: "warn", text: `${load - budget} over budget · running work continues` };
  if (reading.state === "saturated") return { tone: "warn", text: "Requests queuing · new work goes to the next route" };
  if (reading.state === "full") return { tone: "warn", text: `Under ${QUOTA_CUTOFF}% quota left · new work goes to the next route` };
  if (!reading.confirmed) {
    return free > 0
      ? { tone: "muted", text: `${free} ${plural(free, "slot")} by budget · no live data to confirm` }
      : { tone: "muted", text: "Budget full · no live data" };
  }
  if (free > 0) return { tone: "free", text: `${free} delegate ${plural(free, "slot")} free` };
  if (reading.running === 0) return { tone: "muted", text: "Budget full · runtime idle" };
  return { tone: "muted", text: "Budget full" };
}

/** A cloud route's verdict: the slot verdict when it has a budget, otherwise only what its quota says. */
export function cloudVerdict(route: DeskRoute, quotaState: string): Verdict | null {
  if (route.budget != null) {
    return slotVerdict(route.load, route.budget, { state: quotaState, confirmed: quotaState !== "no-signal", running: null });
  }
  if (quotaState === "full") return { tone: "warn", text: `Under ${QUOTA_CUTOFF}% left · treated as full` };
  if (quotaState === "no-signal") return { tone: "muted", text: "No quota reading · not checked before dispatch" };
  return null;
}

/** Free delegate slots the desk can confirm, and the local routes it can't. */
export function localCapacity(routes: DeskRoute[], unitNames?: Record<string, string>) {
  let free = 0;
  const unconfirmed: string[] = [];
  for (const route of routes) {
    const reading = localReading(route.signal);
    if (!reading.confirmed) unconfirmed.push(routeName(route, unitNames));
    else if (reading.state === "room" && route.budget != null) free += Math.max(route.budget - route.load, 0);
  }
  return { free, unconfirmed };
}

/** Windows still current at `nowSec`. A window without a reset time is kept as reported. */
function current(windows: DeskQuotaWindow[] | undefined, nowSec: number): DeskQuotaWindow[] {
  return (windows ?? []).filter(
    (w) => finite(w.remaining) != null && (w.resets_at == null || w.resets_at > nowSec)
  );
}

const lowest = (windows: DeskQuotaWindow[]) => Math.min(...windows.map((w) => w.remaining));

export interface HubQuota {
  kind: "hub";
  state: string;
  age: number | null;
  /** The account window with the least left, shown up front. */
  tightest: { account: string; window: DeskQuotaWindow } | null;
  accounts: { account: string; usable: boolean; reason: string | null; windows: DeskQuotaWindow[] }[];
}

export interface HostQuota {
  kind: "hosts";
  state: string;
  /** Youngest reading across hosts. */
  age: number | null;
  windows: DeskQuotaWindow[];
  hostCount: number;
  /** Set when hosts report different quota: each host's lowest window. */
  disagreement: { host: string; lowest: number }[] | null;
}

export type QuotaView = HubQuota | HostQuota | { kind: "none"; state: string };

export function quotaView(route: DeskRoute, nowSec: number): QuotaView {
  const hub = route.signal;
  if (hub?.kind === "quota" && Array.isArray(hub.accounts)) {
    const accounts = hub.accounts.map((a) => ({
      account: a.account, usable: a.usable, reason: a.reason, windows: current(a.windows, nowSec),
    }));
    let tightest: HubQuota["tightest"] = null;
    for (const a of accounts) {
      if (!a.usable) continue;
      for (const w of a.windows) if (!tightest || w.remaining < tightest.window.remaining) tightest = { account: a.account, window: w };
    }
    return { kind: "hub", state: hub.state, age: finite(hub.age), tightest, accounts };
  }
  const perHost = Object.entries(route.signals ?? {})
    .map(([host, signal]) => ({ host, signal, windows: current(signal.windows, nowSec) }));
  const reporting = perHost.filter((h) => h.windows.length > 0);
  if (!reporting.length) {
    // A hub signal with no account list, or no host reading at all.
    return { kind: "none", state: hub?.state ?? "no-signal" };
  }
  const shape = (windows: DeskQuotaWindow[]) =>
    JSON.stringify([...windows].sort((a, b) => a.name.localeCompare(b.name)).map((w) => [w.name, Math.round(w.remaining)]));
  const agree = reporting.every((h) => shape(h.windows) === shape(reporting[0].windows));
  // Each window shows the lowest any host reports for it, so no host's tighter reading is hidden.
  const lowestByName = new Map<string, DeskQuotaWindow>();
  for (const h of reporting) {
    for (const w of h.windows) {
      const seen = lowestByName.get(w.name);
      if (!seen || w.remaining < seen.remaining) lowestByName.set(w.name, w);
    }
  }
  const ages = perHost.map((h) => finite(h.signal.age)).filter((a): a is number => a != null);
  return {
    kind: "hosts",
    state: perHost.some((h) => h.signal.state === "full") ? "full"
      : reporting.some((h) => h.signal.state === "room") ? "room" : reporting[0].signal.state,
    age: ages.length ? Math.min(...ages) : null,
    windows: [...lowestByName.values()],
    hostCount: reporting.length,
    disagreement: agree ? null : reporting.map((h) => ({ host: h.host, lowest: Math.round(lowest(h.windows)) })),
  };
}

export const windowName = (name: string) => (name === "5h" ? "5-hour" : name === "weekly" ? "Weekly" : name);

export function prIsOpen(override: DeskOverride | undefined): boolean {
  return Boolean(override?.pr && (override.pr.state ?? "open") === "open");
}

/** A PR link is only rendered for a plain https URL. */
export function safePrUrl(url: string | undefined): string | null {
  return typeof url === "string" && /^https:\/\/[^\s"<>]+$/.test(url) ? url : null;
}

/** The status with one route's override replaced by the desk's acknowledged answer. */
export function withOverride(
  data: DelegationDeskStatus,
  key: string,
  override: DeskOverride | null
): DelegationDeskStatus {
  const overrides = { ...(data.overrides ?? {}) };
  if (override) overrides[key] = override;
  else delete overrides[key];
  return {
    ...data,
    overrides,
    routes: data.routes.map((route) =>
      route.key === key ? { ...route, budget: override ? override.budget : rosterBudget(route) } : route
    ),
  };
}
