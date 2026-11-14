import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import type { SparkSnapshot, StorageBulkDeleteJob, StorageEntry, StorageStatus } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { RotateIcon } from "../ui/icons";
import { AdminFields } from "./AdminFields";
import { AnalysePanel, locationPath, type LocationId } from "./AnalysePanel";
import { Banner, type BannerProps } from "./Banner";
import { BulkDeleteDialog, BulkDeleteReport, bulkFixable } from "./BulkDeleteDialog";
import { DeleteDialog, type DeleteTarget } from "./DeleteDialog";
import { FolderBrowser } from "./FolderBrowser";
import { ScanProgress, ScanStop, formatElapsed, scanHoldNote, scanStopNote } from "./ScanProgress";
import { pruneSelection, summarize, type Selection, type SelectionSummary } from "./selection";
import { baseName, buildIndex, freesOf, parentPath, sharedOf, type SortKey } from "./storageTree";
import type { AdminAccess } from "./useAdminAccess";
import { useBulkDelete } from "./useBulkDelete";
import type { StorageScan } from "./useStorageScan";

export type Notice = Pick<BannerProps, "tone"> & { text: string };

/** The element that says why starting work is off (the offline banner); disabled controls point at it. */
export const READ_ONLY_REASON_ID = "st-readonly-reason";

interface FilesTabProps {
  spark: SparkSnapshot;
  /** Null while the Spark is offline: there is nothing to read from it, only the saved analysis to look at. */
  status: StorageStatus | null;
  /** Set when nothing may be started (offline): the saved analysis can be browsed, not changed or refreshed. */
  readOnlyReason?: string | null;
  access: AdminAccess;
  scan: StorageScan;
  /** The folder in the address bar, or null for the top of the analysis. */
  view: string | null;
  /** Change the folder in the address bar. Pushing lets Back return to the one before. */
  onView: (path: string | null, mode: "push" | "replace") => void;
  onNotice: (notice: Notice | null) => void;
  /** Disk numbers above the tabs are out of date after a delete. */
  onDiskChanged: () => void;
}

function describeLocation(path: string, status: StorageStatus): { id: LocationId; custom: string } {
  for (const id of ["disk", "home", "cache"] as const) {
    if (locationPath(id, "", status) === path) return { id, custom: "" };
  }
  return { id: "custom", custom: path };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong");

/** Find what fills the disk: choose a place, analyse, then browse the result biggest first and delete from it. */
export function FilesTab({ spark, status, readOnlyReason = null, access, scan, view: wantedView, onView, onNotice, onDiskChanged }: FilesTabProps) {
  const { job, session } = scan;
  const readOnly = readOnlyReason != null;
  const [location, setLocation] = useState<LocationId>("disk");
  const [custom, setCustom] = useState("");
  const [asAdmin, setAsAdmin] = useState(status ? status.sudo !== "no" : false);
  // Opened while offline: pick the administrator default once the Spark's sudo answer is known.
  const sudoKnown = status?.sudo;
  const adminSeeded = useRef(status != null);
  useEffect(() => {
    if (adminSeeded.current || !sudoKnown) return;
    adminSeeded.current = true;
    setAsAdmin(sudoKnown !== "no");
  }, [sudoKnown]);
  const [choosing, setChoosing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("size");
  const [filter, setFilter] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [stopping, setStopping] = useState(false);
  // Ticked rows of the folder shown (paths). Cleared when the folder or the Spark changes (this tab is keyed by Spark).
  const [selected, setSelected] = useState<Selection>(() => new Set());
  // The bulk delete dialog's items while it is open, and how the last bulk delete ended.
  const [bulkTarget, setBulkTarget] = useState<SelectionSummary | null>(null);
  const bulkOpen = useRef(false);
  bulkOpen.current = bulkTarget != null;
  const [bulkReport, setBulkReport] = useState<{ job: StorageBulkDeleteJob; freed: number | null; shared: number } | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  // "stopping" counts as running: the scan is shown until the Spark confirms it stopped.
  const running = job?.state === "running" || job?.state === "stopping";
  // The Spark stays busy for the scan (also after lost contact or an unconfirmed stop): nothing else may start.
  const scanBusy = scan.busy;
  const index = useMemo(() => buildIndex(session?.entries ?? []), [session?.entries]);

  // "Stopped": said once, when a stop asked for on this page is confirmed by the Spark.
  const stopAsked = useRef<string | null>(null);
  useEffect(() => {
    const confirmed = job?.stop?.outcome === "terminated" || job?.stop?.outcome === "already-gone";
    if (!job || stopAsked.current !== job.id || !confirmed || job.holdsSpark) return;
    stopAsked.current = null;
    onNotice({ tone: "ok", text: `Scan stopped. ${job.stop?.message ?? "Nothing of it is left running on the Spark."}` });
  }, [job, onNotice]);

  // The folder shown: the one in the address bar when this analysis knows it, else the nearest known
  // folder above it, else the top. (A link to a folder that was never scanned lands on its parent.)
  const root = session?.root ?? null;
  const view = useMemo(() => {
    if (root == null) return "/";
    for (let p: string | null = wantedView; p != null; p = parentPath(p)) {
      if (index.byPath.has(p)) return p;
    }
    return root;
  }, [wantedView, index, root]);
  // A new folder starts without the last folder's filter or selection.
  useEffect(() => {
    setFilter("");
    setSelected(new Set());
  }, [view]);
  // A rescan or a delete keeps what is still there and can still be deleted, and drops the rest.
  useEffect(() => setSelected((prev) => pruneSelection(prev, index.byPath)), [index]);

  // ─── Bulk delete ───
  const onBulkFinished = (finished: StorageBulkDeleteJob, startedHere: boolean) => {
    // Nothing deleted, for a reason the dialog can fix (a password, the acknowledgement): it stays open and says so.
    if (startedHere && bulkOpen.current && bulkFixable(finished)) return;
    setBulkTarget(null);
    // About what it freed, from the analysis as it was (each item's own "frees"), before the refresh drops them.
    let freed = 0;
    let shared = 0;
    let known = true;
    for (const p of finished.deleted) {
      const entry = index.byPath.get(p);
      if (!entry) known = false;
      else {
        freed += freesOf(entry);
        shared += sharedOf(entry);
      }
    }
    setBulkReport({ job: finished, freed: known ? freed : null, shared });
    onNotice(null);
    void scan.refresh();
    onDiskChanged();
    // Back to the list: to the button that opened the dialog when it is still there (some items are left), else
    // to the "select all" box, once the dialog has gone.
    window.setTimeout(() => {
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected) selectAllRef.current?.focus();
    }, 320);
  };
  const bulk = useBulkDelete(spark.id, onBulkFinished);
  const bulkRunning = bulk.job?.state === "running";

  // A finished new analysis opens at its top, rewriting the address in place. Only for one started
  // on this page: reopening the page on a finished analysis must keep the folder in the link.
  const startedHere = useRef(false);
  const openedJob = useRef<string | null>(null);
  useEffect(() => {
    if (!startedHere.current || job?.state !== "done" || job.mode !== "new" || openedJob.current === job.id) return;
    openedJob.current = job.id;
    startedHere.current = false;
    onView(null, "replace");
  }, [job?.id, job?.state, job?.mode, onView]);

  const goTo = useCallback(
    (path: string) => {
      if (path === view) return;
      onView(path === root ? null : path, "push");
    },
    [view, root, onView]
  );

  const begin = useCallback(
    async (path: string, admin: boolean, mode: "new" | "drill") => {
      setProblem(null);
      try {
        if (mode === "new") startedHere.current = true;
        await scan.start({ path, depth: 3, mode, ...access.elevation(admin) });
        if (mode === "new") setChoosing(false);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === "bad-password") access.forget();
        const text = errorText(err);
        if (mode === "new") {
          startedHere.current = false;
          setProblem(text);
        }
        else onNotice({ tone: "error", text });
        return false;
      }
    },
    [scan, access, onNotice]
  );

  const analyse = () => {
    if (!status || readOnly) return;
    const path = locationPath(location, custom, status);
    if (path) void begin(path, asAdmin, "new");
  };

  const analyseAgain = () => {
    if (!session || !status || readOnly) return;
    const admin = session.elevated;
    if (admin && !access.ready) {
      // The password was forgotten: ask for it on the start panel, set to the same place.
      const where = describeLocation(session.root, status);
      setLocation(where.id);
      setCustom(where.custom);
      setAsAdmin(true);
      setChoosing(true);
      return;
    }
    void begin(session.root, admin, "new");
  };

  const analyseAsAdmin = () => {
    if (!session || !status || readOnly) return;
    setAsAdmin(true);
    if (access.ready && access.available) {
      void begin(session.root, true, "new");
      return;
    }
    const where = describeLocation(session.root, status);
    setLocation(where.id);
    setCustom(where.custom);
    setChoosing(true);
  };

  const openFolder = (entry: StorageEntry) => {
    goTo(entry.path);
    // Offline: open it to see that it was not measured, but start nothing.
    if (!entry.expanded && !scanBusy && !readOnly) void begin(entry.path, session?.elevated ?? false, "drill");
  };

  const stop = async () => {
    setStopping(true);
    if (job) stopAsked.current = job.id;
    try {
      await scan.cancel();
    } catch (err) {
      onNotice({ tone: "error", text: errorText(err) });
    } finally {
      setStopping(false);
    }
  };

  const onDeleted = async (target: DeleteTarget) => {
    setDeleteTarget(null);
    const shared = target.sharedBytes ?? 0;
    onNotice({
      tone: "ok",
      text: `Deleted ${baseName(target.path)}. About ${formatBytes(Math.max(0, target.bytes - shared))} freed.${shared > 0 ? ` ${formatBytes(shared)} of it is hard-linked elsewhere and stays on disk until its other links are deleted.` : ""}`,
    });
    await scan.refresh();
    onDiskChanged();
    // Looking inside what was just deleted: step up, replacing the entry that no longer exists.
    if (view === target.path || view.startsWith(`${target.path}/`)) {
      const up = parentPath(target.path);
      onView(up === root ? null : up, "replace");
    }
  };

  const dismissedWhileRunning = running && job?.mode === "new";

  // ─── Which screen ───
  if (scan.loading) {
    return (
      <section className="panel st-state" role="status" aria-live="polite">
        <h2>Checking for an earlier analysis…</h2>
      </section>
    );
  }

  if (dismissedWhileRunning && job) {
    return (
      <ScanProgress sparkName={spark.name} path={job.path} elapsedMs={scan.elapsedMs} job={job} serverNow={scan.serverNow} onStop={() => void stop()} requesting={stopping} />
    );
  }

  const failedNew = job?.state === "error" && job.mode === "new" ? job.error : null;
  if (!session && (readOnly || !status)) {
    return (
      <section className="panel st-state" role="status">
        <h2>No saved analysis for {spark.name}</h2>
        <p>{scan.loadError ? `Could not read the earlier analysis: ${scan.loadError}` : `Analyse ${spark.name} once it can be reached again; the result is kept here for when it is offline.`}</p>
      </section>
    );
  }
  if (!session || choosing) {
    if (!status) return null;
    return (
      <>
        {scan.loadError ? <Banner tone="warn">Could not read the earlier analysis: {scan.loadError}</Banner> : null}
        <AnalysePanel
          sparkId={spark.id}
          sparkName={spark.name}
          status={status}
          access={access}
          location={location}
          onLocation={setLocation}
          custom={custom}
          onCustom={setCustom}
          asAdmin={asAdmin}
          onAsAdmin={setAsAdmin}
          disabled={scanBusy}
          busyNote={scanBusy ? scanHoldNote(job, scan.serverNow()) : null}
          onAnalyse={analyse}
          problem={problem ?? failedNew?.message ?? null}
          onBack={session ? () => setChoosing(false) : undefined}
        />
      </>
    );
  }

  // ─── Results ───
  const rootEntry = index.byPath.get(session.root);
  const mainFs = session.root === "/" ? status?.filesystems.find((f) => f.mount === "/") : undefined;
  const uncounted = mainFs && rootEntry ? mainFs.usedBytes - rootEntry.bytes : 0;
  const uncountedNote = mainFs != null && !session.elevated && session.unreadable > 0 && uncounted > mainFs.totalBytes * 0.02;
  const drillError = job?.state === "error" && job.mode === "drill" && job.path === view ? job.error : null;
  const looking = running && job?.mode === "drill" && job.path === view;
  const busy = scanBusy || deleteTarget != null || bulkTarget != null || bulkRunning;
  const deleteBlocked = scanBusy
    ? "A scan is using this Spark: nothing can be deleted until it has finished."
    : bulkRunning
      ? "A bulk delete is still running on this Spark."
      : null;

  const deleteSelected = () => {
    const picked = summarize(selected, index.byPath);
    if (picked.items.length === 0) return;
    // One item: the ordinary delete dialog (a folder's name to type, nothing to type for a file).
    if (picked.items.length === 1 && picked.covered === 0) {
      const e = picked.items[0];
      setDeleteTarget({ path: e.path, type: e.type, bytes: e.bytes, sharedBytes: sharedOf(e) });
      return;
    }
    setBulkReport(null);
    setBulkTarget(picked);
  };
  const drillNote = looking && job ? scanStopNote(job, scan.serverNow()) : null;
  const viewEntry = index.byPath.get(view);

  const unscannedNote = looking ? (
    <div className="st-looking" role="status" aria-live="polite">
      <RotateIcon className="st-looking__spin h-4 w-4" />
      <span>
        Looking inside <b>{baseName(view)}</b>… <span className="mono">{formatElapsed(scan.elapsedMs)}</span>
      </span>
      {job ? <ScanStop job={job} serverNow={scan.serverNow} onStop={() => void stop()} requesting={stopping} /> : null}
      {drillNote ? <p className="st-looking__note">{drillNote}</p> : null}
    </div>
  ) : readOnly ? (
    <div className="st-looking">
      <p>
        The saved analysis did not measure inside this folder. It can be looked inside once {spark.name} can be reached again.
      </p>
    </div>
  ) : drillError ? (
    <div className="st-looking is-error" role="alert">
      <p>{drillError.message}</p>
      {drillError.code === "no-sudo" || drillError.code === "bad-password" ? (
        <AdminFields access={access} purpose="to read this folder" problem={null} onSubmit={() => void begin(view, true, "drill")} />
      ) : null}
      <button type="button" className="btn btn--sm" onClick={() => void begin(view, session.elevated || drillError.code === "no-sudo" || drillError.code === "bad-password", "drill")}>
        Try again
      </button>
    </div>
  ) : (
    <div className="st-looking">
      <p>This folder has not been measured yet.</p>
      <button type="button" className="btn btn--sm btn--primary" onClick={() => void begin(view, session.elevated, "drill")} disabled={scanBusy}>
        Look inside {viewEntry ? baseName(viewEntry.path) : ""}
      </button>
    </div>
  );

  return (
    <>
      {session.unreadable > 0 && !session.elevated ? (
        <Banner
          tone="warn"
          action={
            <button
              type="button"
              className="btn btn--sm"
              onClick={analyseAsAdmin}
              disabled={busy || readOnly || !(access.available || (status != null && status.sudo !== "no"))}
              aria-describedby={readOnly ? READ_ONLY_REASON_ID : undefined}
            >
              Analyse as administrator
            </button>
          }
        >
          <b>
            {session.unreadable} folder{session.unreadable === 1 ? "" : "s"} could not be opened
          </b>
          , so the sizes below are incomplete
          {uncountedNote ? ` (about ${formatBytes(uncounted)} of the used space is not counted)` : ""}. Docker&rsquo;s storage is usually one of them.
        </Banner>
      ) : null}
      {session.timedOut ? (
        <Banner tone="warn">
          The Spark stopped this analysis early because it was taking very long, so sizes are incomplete. Try a smaller folder.
        </Banner>
      ) : null}
      {job?.state === "error" && job.mode === "new" ? <Banner tone="error">The last analysis failed: {job.error?.message}</Banner> : null}
      {job?.holdsSpark && !running ? (
        <Banner tone="warn" action={job.cancellable !== false ? <ScanStop job={job} serverNow={scan.serverNow} onStop={() => void stop()} requesting={stopping} /> : undefined}>
          {scanHoldNote(job, scan.serverNow())}
        </Banner>
      ) : null}
      {bulkRunning && bulk.job && bulkTarget == null ? (
        // Started before this page was opened (or reloaded): the Spark finishes it; the result shows here when it ends.
        <Banner tone="info">
          <b>
            Deleting {Math.min(bulk.job.done + 1, bulk.job.total)} of {bulk.job.total} on {spark.name}…
          </b>{" "}
          A bulk delete started earlier is still running. The Spark stays busy until it has finished.
        </Banner>
      ) : null}
      {bulkReport ? <BulkDeleteReport job={bulkReport.job} freed={bulkReport.freed} shared={bulkReport.shared} onDismiss={() => setBulkReport(null)} /> : null}
      <FolderBrowser
        index={index}
        root={session.root}
        analysedAt={session.analysedAt ?? session.scannedAt}
        serverNow={scan.serverNow}
        elevated={session.elevated}
        hardlinksApprox={session.hardlinks === "approx"}
        dated={session.dated === true}
        view={view}
        onView={goTo}
        scanning={running}
        sort={sort}
        onSort={setSort}
        filter={filter}
        onFilter={setFilter}
        onDelete={(e) => setDeleteTarget({ path: e.path, type: e.type, bytes: e.bytes, sharedBytes: sharedOf(e) })}
        onRescan={analyseAgain}
        onNewAnalysis={() => setChoosing(true)}
        disabled={busy}
        lockedReason={readOnlyReason}
        lockedReasonId={READ_ONLY_REASON_ID}
        unscannedNote={unscannedNote}
        onOpen={openFolder}
        selected={selected}
        onSelect={setSelected}
        onDeleteSelected={deleteSelected}
        deleteBlocked={deleteBlocked}
        selectAllRef={selectAllRef}
      />
      <BulkDeleteDialog
        sparkId={spark.id}
        sparkName={spark.name}
        selection={bulkTarget}
        access={access}
        preferAdmin={session.elevated}
        ack={status?.elevatedDeleteAck ?? null}
        account={status?.user ?? null}
        onAckChanged={onDiskChanged}
        job={bulk.job}
        onStart={bulk.start}
        onClose={() => setBulkTarget(null)}
      />
      <DeleteDialog
        sparkId={spark.id}
        sparkName={spark.name}
        target={deleteTarget}
        access={access}
        preferAdmin={session.elevated}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(t) => void onDeleted(t)}
        ack={status?.elevatedDeleteAck ?? null}
        account={status?.user ?? null}
        onAckChanged={onDiskChanged}
        onAttention={onDiskChanged}
      />
    </>
  );
}
