import { Fragment, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { StorageEntry } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { formatSince } from "../../shared/formatSince";
import { isStale, relativeTime, usableSeconds } from "../../shared/relativeTime";
import { ChevronRightIcon, FileIcon, FolderIcon, LinkIcon, LockIcon, RotateIcon, SearchIcon, TrashIcon, XIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { headerState, isSelectable, selectRange, selectedAncestor, summarize, toggleAllShown, toggleOne, type Selection } from "./selection";
import {
  SHARE_COLORS,
  baseName,
  breadcrumb,
  filterRows,
  folderView,
  formatShare,
  freesNothing,
  freesOf,
  sharedOf,
  shareSegments,
  sortRows,
  type Row,
  type SortKey,
  type TreeIndex,
} from "./storageTree";

const colorVar = (rank: number | null) => (rank != null && rank < SHARE_COLORS ? `var(--st-c${rank})` : "var(--st-c-rest)");

interface FolderBrowserProps {
  index: TreeIndex;
  /** The folder the analysis started from: the first crumb. */
  root: string;
  /** When the analysis was made (server clock, ms), for the "last analysed" note. */
  analysedAt: number | null;
  /** The server's clock now. */
  serverNow: () => number;
  /** The analysis included folders only administrators can open. */
  elevated: boolean;
  /** Sizes come from the basic scan: hard-linked files may be counted in more than one folder. */
  hardlinksApprox: boolean;
  /** The analysis recorded when things last changed (the basic scan and older analyses did not). */
  dated: boolean;
  /** The folder being looked at. */
  view: string;
  onView: (path: string) => void;
  /** A scan is running: folders that were not scanned yet cannot be opened until it ends. */
  scanning: boolean;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  filter: string;
  onFilter: (text: string) => void;
  onDelete: (entry: StorageEntry) => void;
  /** Open a folder: show it, and scan it first when it was never measured. */
  onOpen: (entry: StorageEntry) => void;
  /** Rescan the whole result from its root. */
  onRescan: () => void;
  onNewAnalysis: () => void;
  /** Interactions that start work are held off. */
  disabled: boolean;
  /**
   * Why nothing can be started or deleted at all (the Spark is offline), or null. Browsing the saved analysis
   * still works; the buttons that would start work stay visible, disabled, and point at `lockedReasonId`.
   */
  lockedReason?: string | null;
  lockedReasonId?: string;
  /** Shown in place of the list when the folder's insides were never scanned. */
  unscannedNote: React.ReactNode;
  /** Ticked rows, by path. Kept while sorting and filtering; the page clears it when the folder changes. */
  selected: Selection;
  onSelect: (next: Selection) => void;
  /** Delete the ticked rows (opens the confirmation). */
  onDeleteSelected: () => void;
  /** Why "Delete selected" cannot be pressed right now (a scan or a delete is running), or null. */
  deleteBlocked?: string | null;
  /** The header check box, so the page can put focus back on the list after a bulk delete. */
  selectAllRef?: RefObject<HTMLInputElement | null>;
}

type Locked = { reason: string; id?: string } | null;

/**
 * The tick box at the start of a row that cannot be deleted from here: disabled, with the reason read out by
 * screen readers (aria-describedby) and shown on hover, a tap or a long press, so the box is never just missing.
 */
function LockedPick({ name, reason }: { name: string; reason: string }) {
  const { t } = useTranslation("storage");
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const t = window.setTimeout(() => setOpen(false), 8000);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span
      ref={ref}
      className={`st-pick is-locked${open ? " is-open" : ""}`}
      onClick={() => setOpen((o) => !o)}
      onContextMenu={(e) => {
        // A long press on a touch screen.
        e.preventDefault();
        setOpen(true);
      }}
    >
      <input type="checkbox" className="st-pick__box" disabled aria-label={t("files.selectItem", { name })} aria-describedby={id} />
      <span id={id} className="st-pick__why" role="tooltip">
        {t("files.cannotSelect", { reason })}
      </span>
    </span>
  );
}

interface PickProps {
  entry: StorageEntry;
  name: string;
  picked: boolean;
  /** A ticked folder above it: it goes with that folder, so its own box shows ticked and cannot be changed. */
  includedBy: string | null;
  locked: Locked;
  onPick: (path: string, shift: boolean) => void;
}

/** The leading tick box of a row. */
function PickCell({ entry, name, picked, includedBy, locked, onPick }: PickProps) {
  const { t } = useTranslation("storage");
  const id = useId();
  if (!isSelectable(entry)) return <LockedPick name={name} reason={entry.locked ?? t("files.unusualName")} />;
  if (includedBy != null) {
    return (
      <span className="st-pick is-included">
        <input type="checkbox" className="st-pick__box" checked disabled aria-label={t("files.selectItem", { name })} aria-describedby={id} />
        <span id={id} className="sr-only">
          {t("files.includedInSelection", { name: baseName(includedBy) })}
        </span>
      </span>
    );
  }
  return (
    <label className="st-pick" title={locked ? t("files.deleteLocked", { reason: locked.reason }) : undefined}>
      <input
        type="checkbox"
        className="st-pick__box"
        checked={picked}
        disabled={locked != null}
        aria-label={t("files.selectItem", { name })}
        aria-describedby={locked?.id}
        // A click on the check box or its label, or Space: shift extends the selection from the row toggled last.
        onChange={(e) => onPick(entry.path, (e.nativeEvent as MouseEvent).shiftKey === true)}
      />
    </label>
  );
}

/** "Last changed": how long ago in words, the exact time on hover, and the full date for screen readers. */
function ChangedCell({ entry, now, dated }: { entry: StorageEntry; now: number; dated: boolean }) {
  const { t } = useTranslation("storage");
  const timestamp = usableSeconds(entry.modifiedAt);
  const words = relativeTime(timestamp, now);
  if (timestamp == null || words == null) {
    const why =
      entry.modifiedAt != null
        ? t("files.dateBefore1980")
        : dated
          ? t("files.dateUnreadable")
          : t("files.datesNotRecorded");
    return (
      <span className="st-row__date is-unknown" title={why}>
        <span aria-hidden>{"—"}</span>
        <span className="sr-only">{t("files.lastChangedWithReason", { reason: why })}</span>
      </span>
    );
  }
  const when = new Date(timestamp * 1000);
  return (
    <time className={`st-row__date${isStale(timestamp, now) ? " is-old" : ""}`} dateTime={when.toISOString()} title={t("files.lastChangedAt", { time: when.toLocaleString() })}>
      <span aria-hidden>{words}</span>
      <span className="sr-only">
        {t("files.lastChangedFull", { words, time: when.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) })}
      </span>
    </time>
  );
}

interface RowItemProps {
  row: Row;
  onOpen: (e: StorageEntry) => void;
  onDelete: (e: StorageEntry) => void;
  openable: boolean;
  disabled: boolean;
  locked?: Locked;
  /** Server clock now (ms), for "3 days ago". */
  now: number;
  dated: boolean;
  /** The "Deleting frees" column is shown: something in this folder is shared with files outside it. */
  showFrees: boolean;
  picked: boolean;
  includedBy: string | null;
  onPick: (path: string, shift: boolean) => void;
}

function RowItem({ row, onOpen, onDelete, openable, disabled, locked = null, now, dated, showFrees, picked, includedBy, onPick }: RowItemProps) {
  const { t } = useTranslation("storage");
  const { entry, name } = row;
  const isDir = entry.type === "dir";
  const canOpen = isDir && !entry.unsafe && openable;
  const icon = isDir ? <FolderIcon className="h-4 w-4" /> : entry.type === "link" ? <LinkIcon className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />;
  const body = (
    <>
      <span className={`st-row__icon${isDir ? " is-dir" : ""}`} aria-hidden>
        {icon}
      </span>
      <span className="st-row__name" title={entry.path}>
        {name}
      </span>
      {entry.type === "link" ? <Tag>{t("files.link")}</Tag> : null}
      {entry.type === "other" ? <Tag>{t("files.special")}</Tag> : null}
    </>
  );
  return (
    <li className={`st-row${picked || includedBy != null ? " is-selected" : ""}`}>
      <span className="st-row__pick">
        <PickCell entry={entry} name={name} picked={picked} includedBy={includedBy} locked={locked} onPick={onPick} />
      </span>
      {canOpen ? (
        <button type="button" className="st-row__open" onClick={() => onOpen(entry)} disabled={disabled} aria-label={t("files.openItem", { name })}>
          {body}
          <ChevronRightIcon className="st-row__chev h-3.5 w-3.5" />
        </button>
      ) : (
        <div className="st-row__open is-static">{body}</div>
      )}
      <span className="st-row__bar" aria-hidden>
        <i style={{ ["--w" as string]: `${Math.max(row.share * 100, row.share > 0 ? 0.6 : 0)}%`, ["--c" as string]: colorVar(row.rank) }}>
          {row.sharedFrac > 0 ? <b style={{ ["--sw" as string]: `${row.sharedFrac * 100}%` }} /> : null}
        </i>
      </span>
      <span className="st-row__size mono">{formatBytes(entry.bytes)}</span>
      <span className="st-row__pct mono">{formatShare(row.share)}</span>
      {/* One cell per column on wide screens; the line under the size on narrow ones. */}
      <span className="st-row__meta">
        <ChangedCell entry={entry} now={now} dated={dated} />
        {showFrees ? (
          <span
            className={`st-row__frees mono${freesNothing(entry) ? " is-zero" : ""}${sharedOf(entry) > 0 ? " is-shared" : ""}`}
            title={
              sharedOf(entry) > 0
                ? t("files.sharedBytesTitle", { bytes: formatBytes(sharedOf(entry)) })
                : t("files.allBytesFreed")
            }
          >
            {formatBytes(freesOf(entry))}
          </span>
        ) : null}
      </span>
      <span className="st-row__act">
        {entry.locked ? (
          <span className="st-lock" title={entry.locked} role="img" aria-label={t("files.cannotDelete", { reason: entry.locked })} tabIndex={0}>
            <LockIcon className="h-3.5 w-3.5" />
          </span>
        ) : (
          <button
            type="button"
            className="st-del"
            onClick={() => onDelete(entry)}
            disabled={locked != null}
            aria-label={t("files.deleteItem", { name })}
            aria-describedby={locked?.id}
            title={
              locked
                ? t("files.deleteLocked", { reason: locked.reason })
                : freesNothing(entry)
                  ? t("files.deleteNoSpaceTitle", { name })
                  : t("files.deleteFreesTitle", { name, bytes: formatBytes(freesOf(entry)) })
            }
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </li>
  );
}

/** "Last analysed 3 h ago". An analysis stays until the next one, so say how old it is. */
function AnalysedNote({ at, now, elevated }: { at: number | null; now: () => number; elevated: boolean }) {
  const { t } = useTranslation("storage");
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (at == null || at <= 0) return null;
  const age = formatSince(at, now());
  const old = now() - at > 24 * 3_600_000;
  return (
    <span className={`st-analysed${old ? " is-old" : ""}`} title={t("files.analysedTitle", { time: new Date(at).toLocaleString(), stale: old ? t("files.analysedStale") : "" })}>
      {t("files.lastAnalysed", { age: age === "0s" ? t("files.justNow") : t("files.ago", { age }) })}
      {elevated ? ` · ${t("files.includingProtected")}` : ""}
    </span>
  );
}

/** One folder of the analysis: where you are, what takes the space in it, and what you can delete. */
export function FolderBrowser(props: FolderBrowserProps) {
  const { t } = useTranslation("storage");
  const { index, root, analysedAt, serverNow, elevated, hardlinksApprox, dated, view, onView, scanning, sort, onSort, filter, onFilter, onDelete, onOpen, onRescan, onNewAnalysis, disabled, unscannedNote } = props;
  const { selected, onSelect, onDeleteSelected, deleteBlocked = null, selectAllRef } = props;
  const locked: Locked = props.lockedReason ? { reason: props.lockedReason, id: props.lockedReasonId } : null;
  const folder = useMemo(() => folderView(index, view), [index, view]);
  const rows = useMemo(() => (folder ? sortRows(filterRows(folder.rows, filter), sort) : []), [folder, filter, sort]);
  const segments = useMemo(() => (folder ? shareSegments(folder) : []), [folder]);

  // ─── Selection ───
  const order = useMemo(() => rows.map((r) => r.entry.path), [rows]);
  // What the header box ticks: the rows shown (a filter narrows it) that can be ticked on their own.
  const shownPickable = useMemo(() => rows.filter((r) => isSelectable(r.entry) && selectedAncestor(r.entry.path, selected) == null).map((r) => r.entry.path), [rows, selected]);
  const head = headerState(selected, shownPickable);
  const summary = useMemo(() => summarize(selected, index.byPath), [selected, index]);
  const hiddenPicked = useMemo(() => {
    const shown = new Set(order);
    let n = 0;
    for (const p of selected) if (!shown.has(p)) n += 1;
    return n;
  }, [selected, order]);
  // The row toggled last: shift-click selects from there to the clicked row.
  const anchor = useRef<string | null>(null);
  useEffect(() => {
    anchor.current = null;
  }, [view]);
  const ownAllRef = useRef<HTMLInputElement | null>(null);
  const allRef = selectAllRef ?? ownAllRef;
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = head === "some";
  });
  const pickable = (path: string) => {
    const e = index.byPath.get(path);
    return e != null && isSelectable(e) && selectedAncestor(path, selected) == null;
  };
  const pick = (path: string, shift: boolean) => {
    onSelect(shift ? selectRange(selected, order, anchor.current, path, pickable) : toggleOne(selected, path));
    anchor.current = path;
  };
  const toggleAll = () => {
    onSelect(toggleAllShown(selected, shownPickable));
    anchor.current = null;
  };

  if (!folder) return null;

  const crumbs = breadcrumb(view, root);
  const total = folder.entry.bytes;
  const hasRows = folder.rows.length > 0;
  // What deleting frees only differs from the size for items shared with files outside them (hard links):
  // the column is there only when something in this folder is, and the delete dialog always says it.
  const anyShared = folder.rows.some((r) => sharedOf(r.entry) > 0);
  const now = serverNow();
  const dateSort = sort === "newest" || sort === "oldest";

  return (
    <section className="panel st-browser" aria-label={t("files.folderContents")}>
      <header className="st-browser__head">
        <nav className="st-crumbs" aria-label={t("files.folderPath")}>
          {crumbs.map((c, i) => (
            <Fragment key={c.path}>
              {i > 0 ? <ChevronRightIcon className="st-crumbs__sep h-3 w-3" /> : null}
              {i === crumbs.length - 1 ? (
                <span className="st-crumbs__here" aria-current="page">
                  {c.label}
                </span>
              ) : (
                <button type="button" className="st-crumbs__link" onClick={() => onView(c.path)}>
                  {c.label}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
        <div className="st-browser__tools">
          <AnalysedNote at={analysedAt} now={serverNow} elevated={elevated} />
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onRescan}
            disabled={disabled || locked != null}
            aria-describedby={locked?.id}
            title={locked ? t("files.analyseLocked", { reason: locked.reason }) : t("files.measureAgain", { path: root })}
          >
            <RotateIcon className="h-3.5 w-3.5" />
            {t("files.analyseAgain")}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onNewAnalysis}
            disabled={disabled || locked != null}
            aria-describedby={locked?.id}
            title={locked ? t("files.analyseLocked", { reason: locked.reason }) : undefined}
          >
            {t("files.lookElsewhere")}
          </button>
        </div>
      </header>

      <div className="st-folder">
        <div className="st-folder__size">
          <span className="st-folder__num mono">{formatBytes(total)}</span>
          <span className="st-folder__label">
            {t("files.inLocation", { location: view === "/" ? t("files.wholeDisk") : view })}
            {sharedOf(folder.entry) > 0 ? (
              <span className="st-folder__shared"> · {t("files.sharedOutside", { bytes: formatBytes(sharedOf(folder.entry)) })}</span>
            ) : null}
          </span>
        </div>
        {segments.length > 0 ? (
          <>
            <div className="st-share" aria-hidden>
              {segments.map((s) => (
                <i key={s.key} title={`${s.label}: ${formatBytes(s.bytes)}`} style={{ ["--w" as string]: `${s.share * 100}%`, ["--c" as string]: colorVar(s.color) }} />
              ))}
            </div>
            <ul className="st-legend" aria-label={t("files.biggestItems")}>
              {segments.map((s) => (
                <li key={s.key}>
                  <i aria-hidden style={{ ["--c" as string]: colorVar(s.color) }} />
                  <span className="st-legend__name">{s.label}</span>
                  <span className="st-legend__pct mono">{formatShare(s.share)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      {hardlinksApprox ? (
        <p className="st-note">
          {t("files.basicScanNote")}
          {dated ? null : ` ${t("files.basicScanNoDates")}`}
        </p>
      ) : !dated && hasRows ? (
        <p className="st-note">{t("files.oldAnalysisNoDates")}</p>
      ) : null}
      {!hardlinksApprox && (anyShared || folder.overlap) ? (
        <p className="st-note" id="st-shared-note">
          {anyShared ? (
            <>
              <i className="st-hatch" aria-hidden /> {t("files.sharedNote")}
            </>
          ) : null}
          {folder.overlap ? ` ${t("files.overlapNote")}` : null}
        </p>
      ) : null}

      {folder.scanned && (hasRows || folder.smallerBytes > 0) ? (
        <div className="st-toolbar">
          <div className="st-search">
            <SearchIcon className="h-3.5 w-3.5" />
            <input type="search" placeholder={t("files.filterFolder")} aria-label={t("files.filterFolder")} value={filter} onChange={(e) => onFilter(e.target.value)} />
            {filter ? (
              <button type="button" onClick={() => onFilter("")} aria-label={t("files.clearFilter")}>
                <XIcon className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          <div className="seg" role="group" aria-label={t("files.sortBy")}>
            <button type="button" aria-pressed={sort === "size"} onClick={() => onSort("size")}>
              {t("files.biggestFirst")}
            </button>
            {/* Newest first on the first click; pressed again, oldest first (what has sat untouched longest). */}
            <button
              type="button"
              aria-pressed={dateSort}
              onClick={() => onSort(sort === "newest" ? "oldest" : "newest")}
              title={sort === "newest" ? t("files.newestSortTitle") : sort === "oldest" ? t("files.oldestSortTitle") : t("files.dateSortTitle")}
            >
              {sort === "oldest" ? t("files.oldestFirst") : t("files.newestFirst")}
            </button>
            <button type="button" aria-pressed={sort === "name"} onClick={() => onSort("name")}>
              {t("files.aToZ")}
            </button>
          </div>
        </div>
      ) : null}

      {!folder.scanned ? (
        <div className="st-empty">{unscannedNote}</div>
      ) : hasRows || folder.smallerBytes > 0 ? (
        <div className={`st-list${anyShared ? " has-frees" : ""}`}>
          {/* The column headings, with the "select all" box first. It stays at the top of the screen while the list
              scrolls; with anything ticked, the selection bar covers the headings (same place, same height). */}
          <div className={`st-cols${selected.size > 0 ? " is-selecting" : ""}`}>
            <label className="st-pick st-pick--all" title={locked ? t("files.deleteLocked", { reason: locked.reason }) : shownPickable.length === 0 ? t("files.nothingDeletable") : undefined}>
              <input
                ref={allRef}
                type="checkbox"
                className="st-pick__box"
                checked={head === "all"}
                disabled={locked != null || shownPickable.length === 0}
                aria-describedby={locked?.id}
                aria-label={head === "all" ? t("files.deselectAll") : t("files.selectAll", { count: shownPickable.length })}
                onChange={toggleAll}
              />
              <span className="st-cols__all" aria-hidden>
                {head === "all" ? t("files.deselectAll") : t("files.selectAll", { count: shownPickable.length })}
              </span>
            </label>
            <span className="st-col" aria-hidden>
              {t("files.name")}
            </span>
            <span className="st-col" aria-hidden />
            <span className="st-col" aria-hidden>
              {t("files.size")}
            </span>
            <span className="st-col" aria-hidden>
              {t("files.share")}
            </span>
            <span className="st-col" aria-hidden title={t("files.lastChangedTitle")}>
              {t("files.lastChanged")}
            </span>
            {anyShared ? (
              <span className="st-col" aria-hidden title={t("files.freesTitle")}>
                {t("files.frees")}
              </span>
            ) : null}
            <span className="st-col" aria-hidden />
            {selected.size > 0 ? (
              <div className="st-selbar" role="group" aria-label={t("files.selectedItems")}>
                <span className="st-selbar__sum" aria-live="polite">
                  <b>{t("files.selected", { count: selected.size })}</b>
                  <span>
                    <span className="st-selbar__dot" aria-hidden>·</span>{t("files.freesAbout", { bytes: formatBytes(summary.frees) })}
                    {hiddenPicked > 0 ? ` · ${t("files.notShown", { count: hiddenPicked })}` : ""}
                    {summary.covered > 0 ? ` · ${t("files.includedChildren", { count: summary.covered })}` : ""}
                  </span>
                </span>
                {shownPickable.length > 0 ? (
                  <button type="button" className="btn btn--sm btn--ghost st-selbar__all" onClick={toggleAll}>
                    {head === "all" ? t("files.deselectAll") : t("files.selectAll", { count: shownPickable.length })}
                  </button>
                ) : null}
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => onSelect(new Set())}>
                  {t("files.clear")}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--danger st-selbar__del"
                  onClick={onDeleteSelected}
                  disabled={locked != null || deleteBlocked != null}
                  aria-describedby={locked?.id}
                  title={locked ? t("files.deleteLocked", { reason: locked.reason }) : (deleteBlocked ?? undefined)}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                  <span className="st-selbar__dellong">{t("files.deleteSelected")}</span>
                  <span className="st-selbar__delshort" aria-hidden>
                    {t("files.delete")}
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <ul className="st-rows">
            {rows.map((row) => (
              <RowItem
                key={row.entry.path}
                row={row}
                onOpen={onOpen}
                onDelete={onDelete}
                openable
                disabled={disabled || (scanning && !row.entry.expanded && row.entry.type === "dir")}
                locked={locked}
                now={now}
                dated={dated}
                showFrees={anyShared}
                picked={selected.has(row.entry.path)}
                includedBy={selectedAncestor(row.entry.path, selected)}
                onPick={pick}
              />
            ))}
            {filter && rows.length === 0 ? <li className="st-rows__none">{t("files.noFilterMatch", { filter })}</li> : null}
            {!filter && folder.smallerBytes > 0 ? (
              <li className="st-row st-row--rest">
                <span className="st-row__pick" />
                <div className="st-row__open is-static">
                  <span className="st-row__icon" aria-hidden>
                    <FolderIcon className="h-4 w-4" />
                  </span>
                  <span className="st-row__name">{t("files.smallerItems")}</span>
                </div>
                <span className="st-row__bar" aria-hidden>
                  <i style={{ ["--w" as string]: `${total > 0 ? (folder.smallerBytes / total) * 100 : 0}%`, ["--c" as string]: "var(--st-c-rest)" }} />
                </span>
                <span className="st-row__size mono">{formatBytes(folder.smallerBytes)}</span>
                <span className="st-row__pct mono">{formatShare(total > 0 ? folder.smallerBytes / total : 0)}</span>
                <span className="st-row__meta">
                  <span className="st-row__date" />
                  {anyShared ? <span className="st-row__frees" /> : null}
                </span>
                <span className="st-row__act" />
              </li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div className="st-empty">
          <p>
            <b>{t("files.nothingHere")}</b> {total > 0 ? t("files.onlyTinyItems") : t("files.folderEmpty")}
          </p>
        </div>
      )}
    </section>
  );
}
