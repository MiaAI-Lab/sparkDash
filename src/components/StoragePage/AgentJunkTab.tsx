import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ApiError, fetchAgentJunk } from "../../api/client";
import type { AgentJunkGroup, AgentJunkItem, AgentJunkResult, AgentJunkSignal, AgentJunkVerdict, SparkSnapshot, StorageBulkDeleteJob, StorageStatus } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { formatSince } from "../../shared/formatSince";
import { ChevronDownIcon, FileIcon, FolderIcon, RotateIcon, SearchIcon, SparkleIcon, TrashIcon } from "../ui/icons";
import { ageParts, currentPick, groupItems, junkSelection, JUNK_VERDICTS, matchesSearch, pickPaths, selectedTotals, verdictCounts, type JunkPick } from "./agentJunk";
import { Banner } from "./Banner";
import { BulkDeleteDialog, BulkDeleteReport, bulkFixable } from "./BulkDeleteDialog";
import type { Notice } from "./FilesTab";
import type { SelectionSummary } from "./selection";
import type { AdminAccess } from "./useAdminAccess";
import { useBulkDelete } from "./useBulkDelete";

/** Rows shown per group before "Show N more". */
export const JUNK_GROUP_ROWS = 8;

interface AgentJunkTabProps {
  spark: SparkSnapshot;
  status: StorageStatus | null;
  access: AdminAccess;
  /** The tab is on screen: the first look starts by itself then. */
  active: boolean;
  onNotice: (n: Notice | null) => void;
  onDiskChanged: () => void;
}

/**
 * Remove agent junk: what coding agents left behind in earlier sessions (worktrees, temporary folders, session logs,
 * editor servers, scratch and backup files, caches), with a smart guess for each item. Smart pick ticks what is
 * surely junk; anything can be ticked or unticked. Removing goes through the ordinary bulk delete dialog, so the
 * delete check, administrator rights and the typed confirmation all apply.
 */
export function AgentJunkTab({ spark, status, access, active, onNotice, onDiskChanged }: AgentJunkTabProps) {
  const { t } = useTranslation("storage");
  const [result, setResult] = useState<AgentJunkResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<AgentJunkVerdict>>(new Set(JUNK_VERDICTS));
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<SelectionSummary | null>(null);
  const [report, setReport] = useState<{ job: StorageBulkDeleteJob; freed: number | null } | null>(null);
  const generation = useRef(0);
  const dialogOpen = useRef(false);
  dialogOpen.current = target != null;

  const look = useCallback(
    async (keepSelection: boolean) => {
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const next = await fetchAgentJunk(spark.id);
        if (mine !== generation.current) return;
        setResult(next);
        // A fresh look starts from the smart guess; one after a delete keeps what is still there and still ticked.
        setSelected((prev) => {
          if (!keepSelection) return pickPaths(next.items, "smart");
          const there = new Set(next.items.map((it) => it.path));
          return new Set([...prev].filter((p) => there.has(p)));
        });
        if (!keepSelection) setOpen(new Set(groupItems(next.items).slice(0, 2).map((g) => g.group)));
      } catch (err) {
        if (mine !== generation.current) return;
        setError(err instanceof ApiError || err instanceof Error ? err.message : t("junk.failed"));
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [spark.id, t]
  );

  // The first look starts by itself when the tab is opened: it only reads.
  const started = useRef(false);
  useEffect(() => {
    if (!active || started.current || !spark.online) return;
    started.current = true;
    void look(false);
  }, [active, spark.online, look]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const onBulkFinished = (finished: StorageBulkDeleteJob, startedHere: boolean) => {
    if (startedHere && dialogOpen.current && bulkFixable(finished)) return;
    setTarget(null);
    let freed = 0;
    let known = true;
    const byPath = new Map((result?.items ?? []).map((it) => [it.path, it]));
    for (const p of finished.deleted) {
      const it = byPath.get(p);
      if (it?.bytes == null) known = false;
      else freed += it.bytes;
    }
    setReport({ job: finished, freed: known ? freed : null });
    onNotice(null);
    onDiskChanged();
    void look(true);
  };
  const bulk = useBulkDelete(spark.id, onBulkFinished);
  const bulkRunning = bulk.job?.state === "running";

  const items = useMemo(() => result?.items ?? [], [result]);
  const counts = useMemo(() => verdictCounts(items), [items]);
  const visible = useMemo(() => items.filter((it) => shown.has(it.verdict) && matchesSearch(it, search)), [items, shown, search]);
  const groups = useMemo(() => groupItems(visible), [visible]);
  const totals = useMemo(() => selectedTotals(items, selected), [items, selected]);
  const allTotals = useMemo(() => selectedTotals(items, new Set(items.map((it) => it.path))), [items]);
  const smartTotals = useMemo(() => selectedTotals(items, pickPaths(items, "smart")), [items]);
  const pick = currentPick(items, selected);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleGroup = (paths: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const toggleVerdict = (v: AgentJunkVerdict) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next.size === 0 ? new Set(JUNK_VERDICTS) : next;
    });

  const removeSelected = () => {
    const summary = junkSelection(items, selected);
    if (summary) {
      setReport(null);
      setTarget(summary);
    }
  };

  const offline = !spark.online;

  return (
    <>
      <section className="panel st-junk">
        <div className="st-junk__hero">
          <span className="st-junk__mark" aria-hidden="true">
            <SparkleIcon className="h-5 w-5" />
          </span>
          <div className="st-junk__intro">
            <h2>
              {t("junk.title")} <span className="st-junk__new">{t("junk.new")}</span>
            </h2>
            <p>{t("junk.description")}</p>
          </div>
          <button type="button" className="btn btn--sm" onClick={() => void look(result != null)} disabled={loading || offline || bulkRunning}>
            <RotateIcon className={`h-3.5 w-3.5${loading ? " st-looking__spin" : ""}`} />
            {result ? t("junk.lookAgain") : t("junk.look")}
          </button>
        </div>

        {offline ? <p className="st-junk__note">{t("junk.offline", { name: spark.name })}</p> : null}

        {loading && !result ? (
          <div className="st-junk__loading" role="status" aria-live="polite">
            <div className="st-junk__progress" aria-hidden="true">
              <i />
            </div>
            <p>
              <b>{t("junk.looking", { name: spark.name })}</b> {t("junk.lookingHelp")}
            </p>
          </div>
        ) : null}

        {error ? (
          <Banner tone="error" onDismiss={() => setError(null)}>
            {t("junk.failedWith", { error })}
          </Banner>
        ) : null}

        {result && items.length === 0 ? (
          <div className="st-junk__empty" role="status">
            <SparkleIcon className="h-6 w-6" />
            <p>
              <b>{t("junk.clean", { name: spark.name })}</b> {t("junk.cleanHelp")}
            </p>
          </div>
        ) : null}

        {result && items.length > 0 ? (
          <>
            <div className="st-junk__summary">
              <div className="st-junk__figure">
                <span className="st-junk__big">{formatBytes(allTotals.bytes)}</span>
                <span className="st-junk__figlabel">{t("junk.found", { count: items.length })}</span>
              </div>
              <div className="st-junk__figure is-smart">
                <span className="st-junk__big">{formatBytes(smartTotals.bytes)}</span>
                <span className="st-junk__figlabel">{t("junk.smartFound", { count: smartTotals.count })}</span>
              </div>
              <div className="st-junk__picks">
                <span className="st-junk__pickslabel">{t("junk.pickLabel")}</span>
                <div className="seg" role="group" aria-label={t("junk.pickLabel")}>
                  {(["smart", "likely", "all", "none"] as JunkPick[]).map((p) => (
                    <button key={p} type="button" aria-pressed={pick === p} onClick={() => setSelected(pickPaths(items, p))}>
                      {p === "smart" ? <SparkleIcon className="h-3.5 w-3.5" /> : null}
                      {pickLabel(t, p)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <p className="st-junk__how">{t("junk.how")}</p>

            <div className="st-junk__filters">
              <div className="st-junk__chips" role="group" aria-label={t("junk.filterLabel")}>
                {JUNK_VERDICTS.map((v) => (
                  <button key={v} type="button" className={`st-junk__chip is-${v}`} aria-pressed={shown.has(v)} onClick={() => toggleVerdict(v)} disabled={counts[v] === 0}>
                    <i aria-hidden="true" />
                    {verdictLabel(t, v)} <span>{counts[v]}</span>
                  </button>
                ))}
              </div>
              <div className="st-search st-junk__search">
                <SearchIcon className="h-3.5 w-3.5" />
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("junk.search")} aria-label={t("junk.search")} />
              </div>
            </div>

            {!result.complete ? <p className="st-junk__note">{t("junk.incomplete")}</p> : null}

            <div className="st-junk__groups">
              {groups.length === 0 ? <p className="st-junk__note">{t("junk.noMatch")}</p> : null}
              {groups.map((g) => {
                const paths = g.items.map((it) => it.path);
                const n = paths.filter((p) => selected.has(p)).length;
                const isOpen = open.has(g.group) || search.trim() !== "";
                const more = expanded.has(g.group) ? 0 : Math.max(0, g.items.length - JUNK_GROUP_ROWS);
                const rows = more > 0 ? g.items.slice(0, JUNK_GROUP_ROWS) : g.items;
                const headId = `st-junk-${g.group}`;
                return (
                  <section key={g.group} className={`st-junk__group${isOpen ? " is-open" : ""}`} aria-labelledby={headId}>
                    <div className="st-junk__ghead">
                      <input
                        type="checkbox"
                        className="st-pick__box"
                        checked={n > 0 && n === paths.length}
                        ref={(el) => {
                          if (el) el.indeterminate = n > 0 && n < paths.length;
                        }}
                        onChange={() => toggleGroup(paths, n < paths.length)}
                        aria-label={t("junk.selectGroup", { group: groupText(t, g.group).title })}
                      />
                      <button type="button" className="st-junk__gopen" aria-expanded={isOpen} onClick={() => setOpen((s) => flip(s, g.group))}>
                        <span className="st-junk__gtext">
                          <b id={headId}>{groupText(t, g.group).title}</b>
                          <span>{groupText(t, g.group).why}</span>
                        </span>
                        <span className="st-junk__gcount">{t("junk.groupCount", { picked: n, count: g.items.length })}</span>
                        <span className="st-junk__gsize">{formatBytes(g.bytes)}</span>
                        <ChevronDownIcon className="st-junk__chev h-4 w-4" />
                      </button>
                    </div>
                    {isOpen ? (
                      <ul className="st-junk__rows">
                        {rows.map((it) => (
                          <JunkRow key={it.path} item={it} picked={selected.has(it.path)} onToggle={() => toggle(it.path)} />
                        ))}
                        {more > 0 ? (
                          <li className="st-junk__more">
                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded((s) => flip(s, g.group))}>
                              {t("junk.showMore", { count: more })}
                            </button>
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </section>
                );
              })}
            </div>

            <p className="st-junk__note">{t("junk.checkedAt", { age: formatSince(result.checkedAt, Date.now()) })}</p>
          </>
        ) : null}
      </section>

      {bulkRunning && bulk.job && target == null ? (
        <Banner tone="info">
          <b>{t("files.bulkDeleting", { current: Math.min(bulk.job.done + 1, bulk.job.total), total: bulk.job.total, sparkName: spark.name })}</b> {t("files.bulkDeleteHold")}
        </Banner>
      ) : null}
      {report ? <BulkDeleteReport job={report.job} freed={report.freed} shared={0} onDismiss={() => setReport(null)} /> : null}

      {result && items.length > 0 ? (
        <div className={`st-junk__bar${totals.count > 0 ? " is-on" : ""}`} role="region" aria-label={t("junk.barLabel")}>
          <span className="st-junk__barsum">
            {totals.count > 0 ? (
              <>
                <b>{t("junk.selected", { count: totals.count })}</b> · {formatBytes(totals.bytes)}
                {totals.unmeasured > 0 ? ` ${t("junk.plusUnmeasured", { count: totals.unmeasured })}` : ""}
              </>
            ) : (
              t("junk.nothingSelected")
            )}
          </span>
          {totals.count > 0 ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
              {t("junk.clear")}
            </button>
          ) : null}
          <button type="button" className="btn btn--danger btn--sm" onClick={removeSelected} disabled={totals.count === 0 || bulkRunning || offline}>
            <TrashIcon className="h-3.5 w-3.5" />
            {totals.count > 0 ? t("junk.remove", { count: totals.count, size: formatBytes(totals.bytes) }) : t("junk.removeNothing")}
          </button>
        </div>
      ) : null}

      <BulkDeleteDialog
        sparkId={spark.id}
        sparkName={spark.name}
        selection={target}
        access={access}
        preferAdmin={false}
        ack={status?.elevatedDeleteAck ?? null}
        account={status?.user ?? null}
        onAckChanged={onDiskChanged}
        job={bulk.job}
        onStart={bulk.start}
        onClose={() => setTarget(null)}
      />
    </>
  );
}

function JunkRow({ item, picked, onToggle }: { item: AgentJunkItem; picked: boolean; onToggle: () => void }) {
  const { t } = useTranslation("storage");
  const Icon = item.type === "d" ? FolderIcon : FileIcon;
  return (
    <li className={`st-junk__row${picked ? " is-picked" : ""}`}>
      <label className="st-junk__rowpick">
        <input type="checkbox" className="st-pick__box" checked={picked} onChange={onToggle} aria-label={t("files.selectItem", { name: item.name })} />
      </label>
      <Icon className={`st-junk__icon h-4 w-4${item.type === "d" ? " is-dir" : ""}`} />
      <span className="st-junk__main">
        <span className="st-junk__name">
          <b>{item.name}</b>
          <span className="st-junk__agent">{item.agent}</span>
        </span>
        <span className="st-junk__path mono st-selectable" title={item.path}>
          {/* Cut from the left so the end of a long path stays; the marks keep the leading "/" in place. */}
          {`\u200e${item.path}\u200e`}
        </span>
        <span className="st-junk__why">
          {ruleText(t, item.rule)}
          {item.signals.map((s) => (
            <SignalChip key={s.code} signal={s} />
          ))}
        </span>
      </span>
      <span className={`st-junk__verdict is-${item.verdict}`}>{verdictLabel(t, item.verdict)}</span>
      <span className="st-junk__size">{formatBytes(item.bytes)}</span>
    </li>
  );
}

function SignalChip({ signal }: { signal: AgentJunkSignal }) {
  const { t } = useTranslation("storage");
  const text = signalText(t, signal);
  if (text == null) return null;
  const tone = ["recent", "uncommitted", "memory", "current-version", "tests-folder"].includes(signal.code) ? "warn" : ["untracked", "worktree-session", "home-root"].includes(signal.code) ? "good" : "plain";
  return <span className={`st-junk__signal is-${tone}`}>{text}</span>;
}

type T = TFunction<"storage">;

function pickLabel(t: T, p: JunkPick): string {
  switch (p) {
    case "smart":
      return t("junk.pick.smart");
    case "likely":
      return t("junk.pick.likely");
    case "all":
      return t("junk.pick.all");
    default:
      return t("junk.pick.none");
  }
}

function verdictLabel(t: T, v: AgentJunkVerdict): string {
  switch (v) {
    case "junk":
      return t("junk.verdict.junk");
    case "likely":
      return t("junk.verdict.likely");
    case "review":
      return t("junk.verdict.review");
    default:
      return t("junk.verdict.keep");
  }
}

function groupText(t: T, g: AgentJunkGroup): { title: string; why: string } {
  switch (g) {
    case "worktrees":
      return { title: t("junk.group.worktrees.title"), why: t("junk.group.worktrees.why") };
    case "temp":
      return { title: t("junk.group.temp.title"), why: t("junk.group.temp.why") };
    case "sessions":
      return { title: t("junk.group.sessions.title"), why: t("junk.group.sessions.why") };
    case "editors":
      return { title: t("junk.group.editors.title"), why: t("junk.group.editors.why") };
    case "scratch":
      return { title: t("junk.group.scratch.title"), why: t("junk.group.scratch.why") };
    default:
      return { title: t("junk.group.caches.title"), why: t("junk.group.caches.why") };
  }
}

/** One plain sentence about what the rule found; empty for a rule this page does not know yet. */
function ruleText(t: T, rule: string): string {
  switch (rule) {
    case "claude-worktree":
      return t("junk.rule.claude-worktree");
    case "codex-worktree":
      return t("junk.rule.codex-worktree");
    case "agent-worktree":
      return t("junk.rule.agent-worktree");
    case "tmp-agent":
      return t("junk.rule.tmp-agent");
    case "tmp-browser":
      return t("junk.rule.tmp-browser");
    case "tmp-tool":
      return t("junk.rule.tmp-tool");
    case "claude-sessions":
      return t("junk.rule.claude-sessions");
    case "claude-state":
      return t("junk.rule.claude-state");
    case "claude-logs":
      return t("junk.rule.claude-logs");
    case "codex-sessions":
      return t("junk.rule.codex-sessions");
    case "gemini-tmp":
      return t("junk.rule.gemini-tmp");
    case "opencode-logs":
      return t("junk.rule.opencode-logs");
    case "continue-sessions":
      return t("junk.rule.continue-sessions");
    case "editor-server":
      return t("junk.rule.editor-server");
    case "editor-logs":
      return t("junk.rule.editor-logs");
    case "aider-files":
      return t("junk.rule.aider-files");
    case "scratch-script":
      return t("junk.rule.scratch-script");
    case "agent-report":
      return t("junk.rule.agent-report");
    case "backup-file":
      return t("junk.rule.backup-file");
    case "core-dump":
      return t("junk.rule.core-dump");
    case "stray-log":
      return t("junk.rule.stray-log");
    case "npx-cache":
      return t("junk.rule.npx-cache");
    case "browser-cache":
      return t("junk.rule.browser-cache");
    case "package-cache":
      return t("junk.rule.package-cache");
    default:
      return "";
  }
}

/** A signal in plain words, or null for one this page does not know yet. */
function signalText(t: T, s: AgentJunkSignal): string | null {
  if (s.code === "age" && s.days != null) {
    const { unit, count } = ageParts(s.days);
    if (unit === "year") return t("junk.signal.age_year", { count });
    if (unit === "month") return t("junk.signal.age_month", { count });
    if (unit === "week") return t("junk.signal.age_week", { count });
    return t("junk.signal.age_day", { count });
  }
  switch (s.code) {
    case "recent":
      return t("junk.signal.recent");
    case "age-unknown":
      return t("junk.signal.age-unknown");
    case "untracked":
      return t("junk.signal.untracked");
    case "no-git":
      return t("junk.signal.no-git");
    case "home-root":
      return t("junk.signal.home-root");
    case "uncommitted":
      return t("junk.signal.uncommitted");
    case "memory":
      return t("junk.signal.memory");
    case "tests-folder":
      return t("junk.signal.tests-folder");
    case "worktree-session":
      return t("junk.signal.worktree-session");
    case "current-version":
      return t("junk.signal.current-version");
    case "size-partial":
      return t("junk.signal.size-partial");
    default:
      return null;
  }
}
