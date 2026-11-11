import { Fragment, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
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
      <input type="checkbox" className="st-pick__box" disabled aria-label={`Select ${name}`} aria-describedby={id} />
      <span id={id} className="st-pick__why" role="tooltip">
        Cannot be selected: {reason}
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
  const id = useId();
  if (!isSelectable(entry)) return <LockedPick name={name} reason={entry.locked ?? "The name has unusual characters, so it cannot be deleted from here."} />;
  if (includedBy != null) {
    return (
      <span className="st-pick is-included">
        <input type="checkbox" className="st-pick__box" checked disabled aria-label={`Select ${name}`} aria-describedby={id} />
        <span id={id} className="sr-only">
          Included: it is inside {baseName(includedBy)}, which is selected.
        </span>
      </span>
    );
  }
  return (
    <label className="st-pick" title={locked ? `${locked.reason}: nothing can be deleted until it is back.` : undefined}>
      <input
        type="checkbox"
        className="st-pick__box"
        checked={picked}
        disabled={locked != null}
        aria-label={`Select ${name}`}
        aria-describedby={locked?.id}
        // A click on the check box or its label, or Space: shift extends the selection from the row toggled last.
        onChange={(e) => onPick(entry.path, (e.nativeEvent as MouseEvent).shiftKey === true)}
      />
    </label>
  );
}

/** "Last changed": how long ago in words, the exact time on hover, and the full date for screen readers. */
function ChangedCell({ entry, now, dated }: { entry: StorageEntry; now: number; dated: boolean }) {
  const t = usableSeconds(entry.modifiedAt);
  const words = relativeTime(t, now);
  if (t == null || words == null) {
    const why =
      entry.modifiedAt != null
        ? "Not known: the date recorded for it is before 1980, which means it was never really set."
        : dated
          ? "Not known: no date could be read for it, or the scan that measured it did not record one."
          : "Not known: this analysis did not record dates.";
    return (
      <span className="st-row__date is-unknown" title={why}>
        <span aria-hidden>{"—"}</span>
        <span className="sr-only">Last changed: {why}</span>
      </span>
    );
  }
  const when = new Date(t * 1000);
  return (
    <time className={`st-row__date${isStale(t, now) ? " is-old" : ""}`} dateTime={when.toISOString()} title={`Last changed ${when.toLocaleString()}`}>
      <span aria-hidden>{words}</span>
      <span className="sr-only">
        Last changed {words}, {when.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
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
      {entry.type === "link" ? <Tag>Link</Tag> : null}
      {entry.type === "other" ? <Tag>Special</Tag> : null}
    </>
  );
  return (
    <li className={`st-row${picked || includedBy != null ? " is-selected" : ""}`}>
      <span className="st-row__pick">
        <PickCell entry={entry} name={name} picked={picked} includedBy={includedBy} locked={locked} onPick={onPick} />
      </span>
      {canOpen ? (
        <button type="button" className="st-row__open" onClick={() => onOpen(entry)} disabled={disabled} aria-label={`Open ${name}`}>
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
                ? `${formatBytes(sharedOf(entry))} of this is hard-linked to files outside it, so it stays on disk when this is deleted.`
                : "Deleting this gives back all of its size."
            }
          >
            {formatBytes(freesOf(entry))}
          </span>
        ) : null}
      </span>
      <span className="st-row__act">
        {entry.locked ? (
          <span className="st-lock" title={entry.locked} role="img" aria-label={`Cannot be deleted here: ${entry.locked}`} tabIndex={0}>
            <LockIcon className="h-3.5 w-3.5" />
          </span>
        ) : (
          <button
            type="button"
            className="st-del"
            onClick={() => onDelete(entry)}
            disabled={locked != null}
            aria-label={`Delete ${name}`}
            aria-describedby={locked?.id}
            title={
              locked
                ? `${locked.reason}: nothing can be deleted until it is back.`
                : freesNothing(entry)
                  ? `Delete ${name}. Deleting frees no space: everything in it is also linked from elsewhere.`
                  : `Delete ${name}. Frees ${formatBytes(freesOf(entry))}.`
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
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (at == null || at <= 0) return null;
  const age = formatSince(at, now());
  const old = now() - at > 24 * 3_600_000;
  return (
    <span className={`st-analysed${old ? " is-old" : ""}`} title={`${new Date(at).toLocaleString()}${old ? ". Sizes may have changed since: analyse again to refresh." : ""}`}>
      Last analysed {age === "0s" ? "just now" : `${age} ago`}
      {elevated ? " · including protected folders" : ""}
    </span>
  );
}

/** One folder of the analysis: where you are, what takes the space in it, and what you can delete. */
export function FolderBrowser(props: FolderBrowserProps) {
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
    <section className="panel st-browser" aria-label="Folder contents">
      <header className="st-browser__head">
        <nav className="st-crumbs" aria-label="Folder path">
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
            title={locked ? `${locked.reason}: it cannot be analysed until it is back` : `Measure ${root} again`}
          >
            <RotateIcon className="h-3.5 w-3.5" />
            Analyse again
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onNewAnalysis}
            disabled={disabled || locked != null}
            aria-describedby={locked?.id}
            title={locked ? `${locked.reason}: it cannot be analysed until it is back` : undefined}
          >
            Look somewhere else
          </button>
        </div>
      </header>

      <div className="st-folder">
        <div className="st-folder__size">
          <span className="st-folder__num mono">{formatBytes(total)}</span>
          <span className="st-folder__label">
            in {view === "/" ? <b>the whole disk</b> : <b className="mono">{view}</b>}
            {sharedOf(folder.entry) > 0 ? (
              <span className="st-folder__shared"> · {formatBytes(sharedOf(folder.entry))} shared with files outside it</span>
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
            <ul className="st-legend" aria-label="Biggest items">
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
          Basic scan: a file hard-linked into several folders may be counted in each of them here.
          {dated ? null : " It does not record when things last changed."}
        </p>
      ) : !dated && hasRows ? (
        <p className="st-note">This analysis was made before dates were recorded: analyse again to see when things last changed.</p>
      ) : null}
      {!hardlinksApprox && (anyShared || folder.overlap) ? (
        <p className="st-note" id="st-shared-note">
          {anyShared ? (
            <>
              <i className="st-hatch" aria-hidden /> Hatched parts are <b>shared</b>: hard-linked to files outside that folder, so deleting the folder does not free them.{" "}
              <b>Frees</b> counts only what would really come back.
            </>
          ) : null}
          {folder.overlap ? " Some folders here hold links to the same files, so their sizes add up to more than the folder." : null}
        </p>
      ) : null}

      {folder.scanned && (hasRows || folder.smallerBytes > 0) ? (
        <div className="st-toolbar">
          <div className="st-search">
            <SearchIcon className="h-3.5 w-3.5" />
            <input type="search" placeholder="Filter this folder" aria-label="Filter this folder" value={filter} onChange={(e) => onFilter(e.target.value)} />
            {filter ? (
              <button type="button" onClick={() => onFilter("")} aria-label="Clear filter">
                <XIcon className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          <div className="seg" role="group" aria-label="Sort by">
            <button type="button" aria-pressed={sort === "size"} onClick={() => onSort("size")}>
              Biggest first
            </button>
            {/* Newest first on the first click; pressed again, oldest first (what has sat untouched longest). */}
            <button
              type="button"
              aria-pressed={dateSort}
              onClick={() => onSort(sort === "newest" ? "oldest" : "newest")}
              title={sort === "newest" ? "Sorted by last change, newest first. Click for oldest first." : sort === "oldest" ? "Sorted by last change, oldest first. Click for newest first." : "Sort by when anything inside last changed"}
            >
              {sort === "oldest" ? "Oldest first" : "Newest first"}
            </button>
            <button type="button" aria-pressed={sort === "name"} onClick={() => onSort("name")}>
              A to Z
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
            <label className="st-pick st-pick--all" title={locked ? `${locked.reason}: nothing can be deleted until it is back.` : shownPickable.length === 0 ? "Nothing shown here can be deleted from the dashboard" : undefined}>
              <input
                ref={allRef}
                type="checkbox"
                className="st-pick__box"
                checked={head === "all"}
                disabled={locked != null || shownPickable.length === 0}
                aria-describedby={locked?.id}
                aria-label={head === "all" ? "Deselect all" : `Select all ${shownPickable.length}`}
                onChange={toggleAll}
              />
              <span className="st-cols__all" aria-hidden>
                {head === "all" ? "Deselect all" : `Select all ${shownPickable.length}`}
              </span>
            </label>
            <span className="st-col" aria-hidden>
              Name
            </span>
            <span className="st-col" aria-hidden />
            <span className="st-col" aria-hidden>
              Size
            </span>
            <span className="st-col" aria-hidden>
              Share
            </span>
            <span className="st-col" aria-hidden title="When anything inside it was last modified">
              Last changed
            </span>
            {anyShared ? (
              <span className="st-col" aria-hidden title="Bytes that come back if you delete it. Files that are also hard-linked from outside stay.">
                Frees
              </span>
            ) : null}
            <span className="st-col" aria-hidden />
            {selected.size > 0 ? (
              <div className="st-selbar" role="group" aria-label="Selected items">
                <span className="st-selbar__sum" aria-live="polite">
                  <b>{selected.size} selected</b>
                  <span>
                    <span className="st-selbar__dot" aria-hidden>·</span>frees about {formatBytes(summary.frees)}
                    {hiddenPicked > 0 ? ` · ${hiddenPicked} not shown` : ""}
                    {summary.covered > 0 ? ` · ${summary.covered} inside selected folders ${summary.covered === 1 ? "is" : "are"} included` : ""}
                  </span>
                </span>
                {shownPickable.length > 0 ? (
                  <button type="button" className="btn btn--sm btn--ghost st-selbar__all" onClick={toggleAll}>
                    {head === "all" ? "Deselect all" : `Select all ${shownPickable.length}`}
                  </button>
                ) : null}
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => onSelect(new Set())}>
                  Clear
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--danger st-selbar__del"
                  onClick={onDeleteSelected}
                  disabled={locked != null || deleteBlocked != null}
                  aria-describedby={locked?.id}
                  title={locked ? `${locked.reason}: nothing can be deleted until it is back.` : (deleteBlocked ?? undefined)}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                  <span className="st-selbar__dellong">Delete selected…</span>
                  <span className="st-selbar__delshort" aria-hidden>
                    Delete…
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
            {filter && rows.length === 0 ? <li className="st-rows__none">Nothing in this folder matches &ldquo;{filter}&rdquo;.</li> : null}
            {!filter && folder.smallerBytes > 0 ? (
              <li className="st-row st-row--rest">
                <span className="st-row__pick" />
                <div className="st-row__open is-static">
                  <span className="st-row__icon" aria-hidden>
                    <FolderIcon className="h-4 w-4" />
                  </span>
                  <span className="st-row__name">Smaller files and folders</span>
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
            <b>Nothing in here.</b> {total > 0 ? "It only holds a few tiny items." : "This folder is empty."}
          </p>
        </div>
      )}
    </section>
  );
}
