import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  fetchDelegationDesk,
  makeDeskOverridePermanent,
  removeDeskOverride,
  setDeskOverride,
} from "../../api/client";
import type {
  DelegationDeskStatus,
  DeskClaim,
  DeskHost,
  DeskOverride,
  DeskQuotaWindow,
  DeskRoute,
} from "../../api/types";
import { ChevronDownIcon, ExternalLinkIcon, MinusIcon, PlusIcon } from "../ui/icons";
import {
  OVERRIDE_HOURS,
  QUOTA_CUTOFF,
  ago,
  cloudHeading,
  cloudVerdict,
  isLocal,
  localCapacity,
  localHeading,
  localReading,
  plural,
  prIsOpen,
  quotaView,
  rosterBudget,
  routeName,
  safePrUrl,
  slotVerdict,
  timeLeft,
  windowName,
  withOverride,
  type Verdict,
} from "./delegationDesk";

const POLL_MS = 10_000;

interface WriteState {
  pending?: number;
  error?: string;
  opening?: boolean;
  prError?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const trimStop = (text: string) => text.replace(/[.\s]+$/, "");

function StateTag({ state }: { state: string }) {
  const tags: Record<string, [string, string]> = {
    saturated: ["tag tag--warn", "Saturated"],
    full: ["tag tag--warn", "Quota low"],
    unavailable: ["tag tag--bad", "Down"],
    "no-signal": ["tag", "No live data"],
  };
  const tag = tags[state];
  return tag ? <span className={tag[0]}>{tag[1]}</span> : null;
}

function VerdictLine({ verdict }: { verdict: Verdict }) {
  return <span className={`dd-verdict dd-verdict--${verdict.tone}`}>{verdict.text}</span>;
}

function SlotBar({ load, budget }: { load: number; budget: number }) {
  const count = Math.max(budget, load, 1);
  return (
    <div className={`dd-slots${budget === 0 ? " is-paused" : ""}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className={i < load ? (i >= budget ? "is-over" : "is-held") : undefined} />
      ))}
    </div>
  );
}

function Delegates({ route, override }: { route: DeskRoute; override?: DeskOverride }) {
  if (route.budget == null) {
    return (
      <div className="dd-row">
        <span className="dd-k">Delegates</span>
        <span className="dd-v dd-num">{route.load} <span className="dd-of">· quota only</span></span>
      </div>
    );
  }
  return (
    <div>
      <div className="dd-row">
        <span className="dd-k">Delegates</span>
        <span className="dd-v dd-num">
          {route.load}<span className="dd-of"> / {route.budget}</span>
          {override ? <span className="dd-ovr-badge"> · override</span> : null}
        </span>
      </div>
      <SlotBar load={route.load} budget={route.budget} />
    </div>
  );
}

function Stepper({ name, value, max, busy, locked, onStep }: {
  name: string;
  value: number;
  max: number;
  busy: boolean;
  locked: boolean;
  onStep: (next: number) => void;
}) {
  const minus = useRef<HTMLButtonElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const lastStep = useRef<-1 | 1 | null>(null);

  // A button that reaches its limit becomes disabled and loses focus; hand focus to the other one.
  useEffect(() => {
    if (busy || lastStep.current == null) return;
    const pressed = lastStep.current === -1 ? minus.current : plus.current;
    const other = lastStep.current === -1 ? plus.current : minus.current;
    lastStep.current = null;
    const focusLost = document.activeElement === pressed || document.activeElement === document.body;
    if (!focusLost) return;
    // A refused write re-enables the pressed button; a successful one may have disabled it.
    if (pressed && !pressed.disabled) pressed.focus();
    else if (other && !other.disabled) other.focus();
  }, [busy, value]);

  const step = (delta: -1 | 1) => {
    if (busy || locked) return;
    lastStep.current = delta;
    onStep(value + delta);
  };
  return (
    <div className={`dd-stepper${busy ? " is-busy" : ""}`} role="group" aria-label={`${name} delegate budget`}>
      <button
        ref={minus}
        type="button"
        aria-label={`Lower ${name} budget to ${Math.max(value - 1, 0)}`}
        aria-disabled={busy || undefined}
        disabled={locked || value <= 0}
        onClick={() => step(-1)}
      >
        <MinusIcon />
      </button>
      <output className="dd-num" aria-live="off">{value}</output>
      <button
        ref={plus}
        type="button"
        aria-label={`Raise ${name} budget to ${value + 1}`}
        aria-disabled={busy || undefined}
        disabled={locked || value >= max}
        onClick={() => step(1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

interface EditActions {
  step: (route: DeskRoute, next: number) => void;
  remove: (route: DeskRoute) => void;
  confirm: (key: string | null) => void;
  openPr: (route: DeskRoute) => void;
}

function OverridePanel({ route, name, override, io, busy, confirming, actions, nowSec }: {
  route: DeskRoute;
  name: string;
  override: DeskOverride;
  io: WriteState;
  /** A write for this route is waiting on the desk: every action waits with it. */
  busy: boolean;
  confirming: boolean;
  actions: EditActions;
  nowSec: number;
}) {
  const waiting = busy || undefined;
  if (confirming) {
    return (
      <div className="dd-ovr">
        <p>Change {name} from {override.roster} to {override.budget} in <code>delegation.md</code>?</p>
        <span className="dd-when">
          Opens a PR on ai-dotfiles using the desk&apos;s GitHub login. Until it merges, the override keeps running and no longer expires.
        </span>
        <div className="dd-btns">
          <button className="btn btn--sm btn--primary" type="button" aria-disabled={waiting} onClick={() => actions.openPr(route)}>Open PR</button>
          <button className="btn btn--sm btn--ghost" type="button" onClick={() => actions.confirm(null)}>Cancel</button>
        </div>
      </div>
    );
  }
  if (io.opening) {
    return <div className="dd-ovr"><span className="dd-pending" role="status">Opening the PR…</span></div>;
  }
  if (prIsOpen(override) && override.pr) {
    const href = safePrUrl(override.pr.url);
    return (
      <div className="dd-ovr">
        <span className="dd-what">Override {override.roster} → {override.budget} · held for PR #{override.pr.number}</span>
        <span className="dd-when">If the PR closes without merging, the override ends and {name} returns to {override.roster}.</span>
        <div className="dd-acts">
          {href ? (
            <a className="dd-link" href={href} target="_blank" rel="noopener noreferrer">
              View PR #{override.pr.number} <ExternalLinkIcon />
            </a>
          ) : null}
          <button className="dd-link" type="button" aria-disabled={waiting} onClick={() => actions.remove(route)}>Remove override (PR stays open)</button>
        </div>
      </div>
    );
  }
  const left = override.expires_at != null ? `${timeLeft(override.expires_at - nowSec)} left` : "no expiry";
  return (
    <div className="dd-ovr">
      <span className="dd-what">Override {override.roster} → {override.budget} · {left}</span>
      {io.prError ? <span className="dd-err" role="alert">{io.prError}</span> : null}
      <div className="dd-acts">
        <button className="dd-link" type="button" aria-disabled={waiting} onClick={() => actions.remove(route)}>Remove override</button>
        <button className="dd-link" type="button" aria-disabled={waiting} onClick={() => actions.confirm(route.key)}>Make permanent…</button>
      </div>
    </div>
  );
}

function EditBlock({ route, name, override, io, confirming, actions, nowSec }: {
  route: DeskRoute;
  name: string;
  override?: DeskOverride;
  io: WriteState;
  confirming: boolean;
  actions: EditActions;
  nowSec: number;
}) {
  const roster = rosterBudget(route) ?? route.budget ?? 0;
  const max = roster * 2;
  const busy = io.pending !== undefined || Boolean(io.opening);
  const locked = prIsOpen(override);
  const shown = io.pending ?? route.budget ?? roster;
  let status = null;
  if (io.pending !== undefined) status = <span className="dd-pending" role="status">Saving {name} at {io.pending}…</span>;
  else if (io.error) status = <span className="dd-err" role="alert">{io.error}</span>;
  else if (locked) status = <span className="dd-hint">Locked while the PR is open. Remove the override to change it again.</span>;
  else if (!override) {
    status = (
      <span className="dd-hint">
        Roster {roster}. A change applies now for {OVERRIDE_HOURS} h, up to {max}. 0 pauses new delegations.
      </span>
    );
  }
  return (
    <div className="dd-edit">
      <div className="dd-budget">
        <span className="dd-budget__k">Budget</span>
        <Stepper
          name={name}
          value={shown}
          max={max}
          busy={busy}
          locked={locked}
          onStep={(next) => actions.step(route, next)}
        />
      </div>
      {status}
      {override ? (
        <OverridePanel route={route} name={name} override={override} io={io} busy={busy} confirming={confirming} actions={actions} nowSec={nowSec} />
      ) : null}
    </div>
  );
}

function Holders({ route, claims, hosts }: { route: DeskRoute; claims: DeskClaim[]; hosts: Record<string, DeskHost> }) {
  const rows = [
    ...route.live.map((d) => ({
      id: d.id,
      title: d.title || d.id,
      host: d.host,
      via: d.source?.startsWith("firstmate") ? "Firstmate" : "T3",
      stale: hosts[d.host]?.state === "stale",
    })),
    ...claims.filter((c) => c.route === route.key).map((c) => ({
      id: `claim:${c.id}`, title: c.title || "Claimed slot", host: c.host, via: "starting", stale: false,
    })),
  ];
  if (!rows.length) return null;
  return (
    <details className="dd-disclosure">
      <summary><ChevronDownIcon />{rows.length} {plural(rows.length, "delegate")}</summary>
      <ul className="dd-list">
        {rows.map((row) => (
          <li key={row.id} className={row.stale ? "is-stale" : undefined}>
            <span className="dd-trunc" title={row.title}>{row.title}</span>
            <span className="dd-sub">{row.host} · {row.via}{row.stale ? " · host not reporting" : ""}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function QuotaBar({ label, window: w, nowSec }: { label: string; window: DeskQuotaWindow; nowSec: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(w.remaining)));
  const tone = pct < QUOTA_CUTOFF ? "is-low" : pct < 30 ? "is-mid" : undefined;
  const reset = w.resets_at != null ? `resets in ${timeLeft(w.resets_at - nowSec)}` : null;
  return (
    <div className="dd-q">
      <div className="dd-row">
        <span className="dd-k">{label}</span>
        <span className="dd-v dd-num">{pct}% left</span>
      </div>
      <div className="dd-qbar" role="img" aria-label={`${label}: ${pct}% left${reset ? `, ${reset}` : ""}`}>
        <i className={tone} style={{ width: `${pct}%` }} />
        <b />
      </div>
      {reset ? <span className="dd-sub">{reset}</span> : null}
    </div>
  );
}

interface ColumnProps {
  route: DeskRoute;
  data: DelegationDeskStatus;
  unitNames: Record<string, string>;
  editing: boolean;
  io: WriteState;
  confirming: boolean;
  actions: EditActions;
  nowSec: number;
}

function ColumnHead({ name, sub, title, state }: { name: string; sub: string; title: string; state: string }) {
  return (
    <>
      <div className="dd-name">
        <b className="dd-trunc" title={name}>{name}</b>
        <StateTag state={state} />
      </div>
      <div className="dd-model dd-trunc" title={title}>{sub}</div>
    </>
  );
}

function LocalColumn({ route, data, unitNames, editing, io, confirming, actions, nowSec }: ColumnProps) {
  const name = routeName(route, unitNames);
  const heading = localHeading(route, unitNames);
  const reading = localReading(route.signal);
  const override = data.overrides?.[route.key];
  return (
    <div className="dd-col">
      <ColumnHead name={heading.title} sub={heading.sub} title={route.model} state={reading.state} />
      <Delegates route={route} override={override} />
      <div className="dd-row">
        <span className="dd-k">Requests</span>
        {reading.running == null ? (
          <span className="dd-v dd-unknown">not reported</span>
        ) : (
          <span className="dd-v dd-num">
            {reading.running} running
            {reading.waiting ? <span className="dd-waiting"> · {reading.waiting} waiting</span> : null}
          </span>
        )}
      </div>
      <div className="dd-row">
        <span className="dd-k">KV cache</span>
        {reading.kvPercent == null
          ? <span className="dd-v dd-unknown">not reported</span>
          : <span className="dd-v dd-num">{reading.kvPercent}%</span>}
      </div>
      {route.budget != null ? <VerdictLine verdict={slotVerdict(route.load, route.budget, reading)} /> : null}
      <span className="dd-sub">sparkDash · {ago(reading.age)}</span>
      {editing && route.budget != null ? (
        <EditBlock route={route} name={name} override={override} io={io} confirming={confirming} actions={actions} nowSec={nowSec} />
      ) : null}
      <Holders route={route} claims={data.claims ?? []} hosts={data.hosts} />
    </div>
  );
}

function CloudColumn({ route, data, unitNames, editing, io, confirming, actions, nowSec }: ColumnProps) {
  const name = routeName(route, unitNames);
  const heading = cloudHeading(route);
  const quota = quotaView(route, nowSec);
  const override = data.overrides?.[route.key];
  let bars: ReactNode;
  let source = "";
  if (quota.kind === "hub") {
    bars = (
      <>
        {quota.tightest ? (
          <QuotaBar label={`${quota.tightest.account} ${windowName(quota.tightest.window.name).toLowerCase()}`} window={quota.tightest.window} nowSec={nowSec} />
        ) : (
          <div className="dd-row"><span className="dd-k">Quota</span><span className="dd-v dd-unknown">not reported</span></div>
        )}
        <details className="dd-disclosure">
          <summary><ChevronDownIcon />All {quota.accounts.length} {plural(quota.accounts.length, "account")}</summary>
          <div className="dd-list">
            {quota.accounts.map((account) => (
              account.usable && account.windows.length ? account.windows.map((w) => (
                <QuotaBar key={`${account.account}-${w.name}`} label={`${account.account} ${windowName(w.name).toLowerCase()}`} window={w} nowSec={nowSec} />
              )) : (
                <div key={account.account} className="dd-row">
                  <span className="dd-k">{account.account}</span>
                  <span className="dd-v dd-unknown">{account.usable ? "not reported" : account.reason || "not usable"}</span>
                </div>
              )
            ))}
          </div>
        </details>
      </>
    );
    source = `${route.provider} hub · ${ago(quota.age)}`;
  } else if (quota.kind === "hosts") {
    bars = (
      <>
        {quota.windows.map((w) => <QuotaBar key={w.name} label={windowName(w.name)} window={w} nowSec={nowSec} />)}
        {quota.disagreement ? (
          <span className="dd-verdict dd-verdict--warn">
            Hosts disagree: {quota.disagreement.map((r) => `${r.host} ${r.lowest}%`).join(" · ")}. Showing the lowest.
          </span>
        ) : null}
      </>
    );
    const from = quota.hostCount === 1 ? "1 host"
      : quota.disagreement ? `lowest of ${quota.hostCount} hosts` : `${quota.hostCount} hosts agree`;
    source = `${from} · ${ago(quota.age)}`;
  } else {
    bars = <div className="dd-row"><span className="dd-k">Quota</span><span className="dd-v dd-unknown">not reported</span></div>;
  }
  const verdict = cloudVerdict(route, quota.state);
  return (
    <div className="dd-col">
      <ColumnHead name={heading.title} sub={heading.sub} title={`${route.provider} · ${route.model}`} state={quota.state} />
      <Delegates route={route} override={override} />
      {bars}
      {verdict ? <VerdictLine verdict={verdict} /> : null}
      {source ? <span className="dd-sub">{source}</span> : null}
      {editing && route.budget != null ? (
        <EditBlock route={route} name={name} override={override} io={io} confirming={confirming} actions={actions} nowSec={nowSec} />
      ) : null}
      <Holders route={route} claims={data.claims ?? []} hosts={data.hosts} />
    </div>
  );
}

function HostsTag({ hosts }: { hosts: Record<string, DeskHost> }) {
  const entries = Object.entries(hosts);
  const missing = entries.filter(([, h]) => h.state !== "fresh").map(([name]) => name);
  if (!entries.length) return <span className="tag tag--warn">No hosts reporting</span>;
  if (!missing.length) return <span className="tag">{entries.length}/{entries.length} hosts reporting</span>;
  return <span className="tag tag--warn">{missing.join(", ")} not reporting</span>;
}

function Waiting({ data }: { data: DelegationDeskStatus }) {
  const waiting = data.waiting ?? [];
  if (!waiting.length) return null;
  return (
    <details className="dd-disclosure dd-waits" role="status">
      <summary><ChevronDownIcon />{waiting.length} {plural(waiting.length, "request")} waiting for a delegate slot</summary>
      <ul className="dd-list">
        {waiting.map((w, i) => (
          <li key={`${w.host}-${i}`}>
            <span className="dd-trunc" title={w.title || "Untitled request"}>{w.title || "Untitled request"}</span>
            <span className="dd-sub">{w.host}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Overview card for the delegation desk: capacity by machine, cloud quota, and
 * (behind "Adjust budgets") expiring budget overrides the desk must acknowledge.
 */
export function DelegationDeskPanel({ unitNames = {} }: { unitNames?: Record<string, string> }) {
  const [data, setData] = useState<DelegationDeskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastGoodMs, setLastGoodMs] = useState<number | null>(null);
  const [editingOn, setEditing] = useState(false);
  const [io, setIo] = useState<Record<string, WriteState>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const reload = useRef<() => void>(() => {});
  // A status read that started before the latest acknowledged write is dropped,
  // so a slow poll can't put the pre-write budget back on screen.
  const acknowledgedWrites = useRef(0);
  // Routes with a write waiting on the desk. One write per route at a time, so two answers
  // can never land out of order and leave the screen showing the older one.
  const writing = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const writesBefore = acknowledgedWrites.current;
      return fetchDelegationDesk()
        .then((next) => {
          if (cancelled || writesBefore !== acknowledgedWrites.current) return;
          setData(next);
          setError(null);
          setLastGoodMs(Date.now());
        })
        .catch((err) => { if (!cancelled) setError(message(err)); });
    };
    reload.current = () => { void load(); };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const track = (key: string, state: WriteState | null) =>
    setIo((all) => {
      const next = { ...all };
      if (state) next[key] = state;
      else delete next[key];
      return next;
    });
  const begin = (key: string, state: WriteState) => {
    if (writing.current.has(key)) return false;
    writing.current.add(key);
    setConfirming(null);
    track(key, state);
    return true;
  };
  const settle = (key: string, state: WriteState | null) => {
    writing.current.delete(key);
    track(key, state);
  };
  /** True when the write may have reached the desk before its answer was lost. */
  const outcomeUnknown = (err: unknown) => err instanceof ApiError && err.status === 504;

  /** Shows the desk's acknowledged answer, then re-reads status so every other field catches up. */
  const acknowledge = (route: DeskRoute, override: DeskOverride | null, text: string) => {
    acknowledgedWrites.current += 1;
    setData((d) => (d ? withOverride(d, route.key, override) : d));
    settle(route.key, null);
    setAnnouncement(text);
    reload.current();
  };
  const refuse = (route: DeskRoute, err: unknown) => {
    const text = outcomeUnknown(err)
      ? `${trimStop(message(err))}. Showing the desk's current value.`
      : `${trimStop(message(err))}. ${routeName(route, unitNames)} stays at ${route.budget}.`;
    settle(route.key, { error: text });
    setAnnouncement(text);
    if (outcomeUnknown(err)) reload.current();
  };

  const actions: EditActions = {
    step: (route, next) => {
      const name = routeName(route, unitNames);
      if (!begin(route.key, { pending: next })) return;
      setDeskOverride(route.key, next)
        .then((result) => acknowledge(
          route,
          result.override,
          !result.override ? `${name} back to roster budget ${next}`
            : next === 0 ? `${name} paused for ${OVERRIDE_HOURS} hours`
              : `${name} budget ${next} for ${OVERRIDE_HOURS} hours`
        ))
        .catch((err) => refuse(route, err));
    },
    remove: (route) => {
      const name = routeName(route, unitNames);
      const held = prIsOpen(data?.overrides?.[route.key]);
      if (!begin(route.key, { pending: rosterBudget(route) ?? 0 })) return;
      removeDeskOverride(route.key)
        .then(() => acknowledge(
          route,
          null,
          held ? `${name} override removed; the PR stays open` : `${name} back to roster budget ${rosterBudget(route)}`
        ))
        .catch((err) => refuse(route, err));
    },
    confirm: (key) => {
      if (key && writing.current.has(key)) return;
      setConfirming(key);
    },
    openPr: (route) => {
      const name = routeName(route, unitNames);
      if (!begin(route.key, { opening: true })) return;
      makeDeskOverridePermanent(route.key)
        .then((result) => {
          const override = { ...result.override, pr: result.override.pr ?? { ...result.pr, state: "open" } };
          acknowledge(route, override, `PR #${override.pr.number} opened for ${name}; the override holds until it merges`);
        })
        .catch((err) => {
          const unknown = outcomeUnknown(err);
          settle(route.key, {
            prError: unknown
              ? `Couldn't confirm the PR: ${trimStop(message(err))}. Showing the desk's current state.`
              : `Couldn't open the PR: ${trimStop(message(err))}. The override still expires on time.`,
          });
          setAnnouncement(`Couldn't open the PR for ${name}`);
          if (unknown) reload.current();
        });
    },
  };

  const live = <div className="sr-only" aria-live="polite">{announcement}</div>;

  const unreachable = error ? (
    <>
      <p className="dd-note dd-note--bad" role="status">
        {error}
        <span className="dd-note__sub">
          {data ? "The columns below are the last good reading. " : ""}
          Agents fail open and dispatch without it. Budgets can&apos;t be changed until it&apos;s back.
        </span>
      </p>
      <span className="dd-sub">
        {lastGoodMs ? `Last good reading ${ago((Date.now() - lastGoodMs) / 1000)}` : "No reading yet"} · retrying every {POLL_MS / 1000} s
      </span>
    </>
  ) : null;

  if (!data) {
    return (
      <section className="panel ov-card ov-dd" aria-labelledby="dd-title">
        <div className="ov-card__head">
          <h2 id="dd-title" className="ov-card__title">Delegation desk</h2>
          {error ? <div className="ov-card__tools"><span className="tag tag--bad">Unreachable</span></div> : null}
        </div>
        {unreachable ?? <p className="dd-sub" role="status">Loading the delegation desk…</p>}
        {live}
      </section>
    );
  }

  // A desk that stopped answering keeps its last reading on screen, but takes no budget changes.
  const canEdit = data.canEdit && !error;
  const editing = editingOn && canEdit;
  const nowSec = Date.now() / 1000;
  const local = data.routes.filter(isLocal);
  const cloud = data.routes.filter((route) => !isLocal(route));
  const capacity = localCapacity(local, unitNames);
  const overrideCount = Object.keys(data.overrides ?? {}).length;
  const column = (route: DeskRoute) => ({
    route, data, unitNames, editing, actions, nowSec,
    io: io[route.key] ?? {},
    confirming: confirming === route.key,
  });

  return (
    <section className="panel ov-card ov-dd ov-dd--wide" aria-labelledby="dd-title">
      <div className="ov-card__head">
        <h2 id="dd-title" className="ov-card__title">Delegation desk</h2>
        <div className="ov-card__tools">
          {overrideCount ? <span className="tag tag--acc">{overrideCount} {plural(overrideCount, "override")} active</span> : null}
          {error ? <span className="tag tag--bad">Unreachable</span> : <HostsTag hosts={data.hosts} />}
          {canEdit ? (
            <button
              className="btn btn--sm btn--ghost dd-edit-toggle"
              type="button"
              aria-pressed={editing}
              onClick={() => {
                setEditing(!editing);
                setConfirming(null);
                setAnnouncement(editing ? "Budget editing off" : "Budget editing on");
              }}
            >
              {editing ? "Done" : "Adjust budgets"}
            </button>
          ) : null}
        </div>
      </div>
      {unreachable}
      <Waiting data={data} />
      {editing ? (
        <p className="dd-note dd-note--acc">
          Budget changes apply as soon as the desk confirms them and last {OVERRIDE_HOURS} hours. Running delegates are never stopped.
        </p>
      ) : null}
      {!data.routes.length ? (
        <p className="dd-sub" role="status">The desk lists no routes.</p>
      ) : null}
      {local.length ? (
        <section className="dd-sec" aria-label="Local machines">
          <div className="dd-sec__head">
            <h3>Local</h3>
            <span className="dd-sec__meta">
              {capacity.free ? <b>{capacity.free} free {plural(capacity.free, "slot")}</b> : "No free slots"}
              {capacity.unconfirmed.length ? ` · ${capacity.unconfirmed.join(", ")} unconfirmed` : ""}
            </span>
          </div>
          <div className="dd-cols">{local.map((route) => <LocalColumn key={route.key} {...column(route)} />)}</div>
        </section>
      ) : null}
      {cloud.length ? (
        <section className="dd-sec" aria-label="Cloud routes">
          <div className="dd-sec__head"><h3>Cloud</h3></div>
          <div className="dd-cols">{cloud.map((route) => <CloudColumn key={route.key} {...column(route)} />)}</div>
        </section>
      ) : null}
      <div className="dd-legend" aria-hidden="true">
        <span><i />Held delegate slot</span>
        <span><i className="is-paused" />Paused</span>
        <span><i className="is-tick" />{QUOTA_CUTOFF}% quota cut-off</span>
      </div>
      {live}
    </section>
  );
}
