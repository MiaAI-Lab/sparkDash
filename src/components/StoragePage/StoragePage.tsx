import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchStorageContext, fetchStorageStatus } from "../../api/client";
import type { SparkSnapshot, StorageContext, StorageStatus } from "../../api/types";
import { formatSince } from "../../shared/formatSince";
import { BoxIcon, DiskIcon, RotateIcon } from "../ui/icons";
import { AdminDeleteAckNote } from "./AdminDeleteAck";
import { Banner } from "./Banner";
import { DiskSummary } from "./DiskSummary";
import { NeedsAttention } from "./NeedsAttention";
import { DockerTab } from "./DockerTab";
import { FilesTab, READ_ONLY_REASON_ID, type Notice } from "./FilesTab";
import { SparkPicker, isStorageSpark } from "./SparkPicker";
import { useAdminAccess } from "./useAdminAccess";
import { useStorageLocation, type StorageTab } from "./useStorageLocation";
import { useStorageScan, type StorageScan } from "./useStorageScan";
import "../../styles/storage.css";

const SPARK_PREF = "sparkdash.storage.spark";
const TAB_PREF = "sparkdash.storage.tab";
const NOTICE_MS = 12_000;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference is a convenience */
  }
}

/**
 * Storage Manager: pick a DGX Spark, analyse its disk to see which folders take the most space,
 * look at Docker's images, and delete what is not needed (as administrator when it takes sudo).
 */
export function StoragePage({ sparks }: { sparks: SparkSnapshot[] }) {
  const candidates = useMemo(() => sparks.filter(isStorageSpark), [sparks]);
  // Spark, tab and folder live in the address bar so Back, Forward and a copied link all work; the
  // last Spark and tab picked are the defaults when the address says nothing.
  const [loc, go] = useStorageLocation();
  const chosen = loc.spark ?? readPref(SPARK_PREF);
  const tab: StorageTab = loc.tab ?? (readPref(TAB_PREF) === "docker" ? "docker" : "files");
  const [dockerSeen, setDockerSeen] = useState(tab === "docker");
  useEffect(() => {
    if (tab === "docker") setDockerSeen(true);
  }, [tab]);
  const [notice, setNotice] = useState<Notice | null>(null);

  // The remembered Spark if it is still there, else the first one that is up.
  const spark =
    candidates.find((s) => s.id === chosen) ?? candidates.find((s) => s.online) ?? candidates[0] ?? null;
  const sparkId = spark?.id ?? null;
  // An offline Spark can still be picked to look at its saved analysis; nothing is asked of it or started on it.
  const offline = spark != null && !spark.online;

  // Write the Spark and tab being shown into the address (replacing the entry, not adding one), so every
  // history entry says exactly what it shows: Back to one must not fall back to the last-used tab.
  useEffect(() => {
    if (sparkId && (loc.spark !== sparkId || loc.tab !== tab)) go({ spark: sparkId, tab }, "replace");
  }, [sparkId, tab, loc.spark, loc.tab, go]);

  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const generation = useRef(0);

  const loadStatus = useCallback(
    async (quiet: boolean) => {
      if (!sparkId || offline) return;
      const mine = ++generation.current;
      if (!quiet) {
        setStatus(null);
        setStatusError(null);
      }
      try {
        const next = await fetchStorageStatus(sparkId);
        if (mine !== generation.current) return;
        setStatus(next);
        setStatusError(null);
      } catch (err) {
        if (mine !== generation.current) return;
        // A failed quiet refresh keeps the numbers already on screen.
        if (!quiet) setStatusError(err instanceof Error ? err.message : "Could not reach the Spark");
      }
    },
    [sparkId, offline]
  );

  useEffect(() => setNotice(null), [sparkId]);

  useEffect(() => {
    // Offline: its disks cannot be read now. Back online: read them again.
    if (!sparkId || offline) {
      setStatus(null);
      setStatusError(null);
      return;
    }
    void loadStatus(false);
    return () => {
      generation.current += 1;
    };
  }, [sparkId, offline, loadStatus]);

  // How the dashboard reaches this Spark, for one quiet line under the disk. Informative only: a failure shows nothing.
  const [context, setContext] = useState<StorageContext | null>(null);
  useEffect(() => {
    setContext(null);
    if (!sparkId || offline) return;
    let live = true;
    void (async () => {
      try {
        const next = await fetchStorageContext(sparkId);
        if (live && next) setContext(next);
      } catch {
        /* the line is a nicety */
      }
    })();
    return () => {
      live = false;
    };
  }, [sparkId, offline]);

  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  const refreshDisks = useCallback(() => void loadStatus(true), [loadStatus]);
  const access = useAdminAccess(sparkId, status, refreshDisks);
  const scan = useStorageScan(sparkId);
  // A finished scan may have used (and so remembered) a typed password.
  const jobState = scan.job?.state;
  useEffect(() => {
    if (jobState === "done" || jobState === "error") refreshDisks();
  }, [jobState, refreshDisks]);

  const pickSpark = (id: string) => {
    writePref(SPARK_PREF, id);
    // Another Spark has other folders: its address starts at the top.
    go({ spark: id, path: null });
  };
  const pickTab = (id: StorageTab) => {
    writePref(TAB_PREF, id);
    go({ tab: id });
  };

  return (
    <div className="st">
      <div className="page-head">
        <div>
          <h1>Storage Manager</h1>
          <p className="page-head__sub">
            See which folders take the most space on a DGX Spark, check what Docker is holding on to, and delete what you no
            longer need.
          </p>
        </div>
      </div>

      {candidates.length === 0 ? (
        <section className="panel st-state" role="status">
          <h2>No DGX Spark to look at</h2>
          <p>Storage Manager works with DGX Spark units. Add one from the sidebar and it will show up here.</p>
        </section>
      ) : (
        <>
          <SparkPicker sparks={candidates} activeId={sparkId} onSelect={pickSpark} />

          {notice ? (
            <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
              {notice.text}
            </Banner>
          ) : null}

          {spark && offline ? (
            <Banner tone="info">
              <span id={READ_ONLY_REASON_ID}>
                <b>{spark.name} is offline.</b> {savedNote(scan)} Analysing, deleting and Docker work again once it can be reached.
              </span>
            </Banner>
          ) : null}

          {spark && !offline && !status && !statusError ? (
            <section className="panel st-state" role="status" aria-live="polite">
              <h2>Reading {spark.name}…</h2>
              <p>Checking the disks and what this account is allowed to do.</p>
            </section>
          ) : null}

          {spark && !offline && statusError && !status ? (
            <section className="panel st-state" role="alert">
              <h2>Could not reach {spark.name}</h2>
              <p>{statusError}</p>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void loadStatus(false)}>
                <RotateIcon className="h-3.5 w-3.5" />
                Try again
              </button>
            </section>
          ) : null}

          {spark && (status || offline) ? (
            <>
              {status && !offline ? <DiskSummary filesystems={status.filesystems} context={context} /> : null}
              {status && !offline ? (
                <>
                  <AdminDeleteAckNote sparkId={spark.id} ack={status.elevatedDeleteAck} account={status.user} onChanged={refreshDisks} />
                  <NeedsAttention
                    sparkId={spark.id}
                    sparkName={spark.name}
                    access={access}
                    account={status.user}
                    ack={status.elevatedDeleteAck}
                    refreshKey={status}
                    onNotice={setNotice}
                    onChanged={refreshDisks}
                  />
                </>
              ) : null}

              <div className="st-tabs seg" role="tablist" aria-label="What to manage">
                <button type="button" role="tab" id="st-tab-files" aria-controls="st-panel-files" aria-selected={tab === "files"} onClick={() => pickTab("files")}>
                  <DiskIcon className="h-3.5 w-3.5" />
                  Files and folders
                </button>
                <button type="button" role="tab" id="st-tab-docker" aria-controls="st-panel-docker" aria-selected={tab === "docker"} onClick={() => pickTab("docker")}>
                  <BoxIcon className="h-3.5 w-3.5" />
                  Docker
                </button>
              </div>

              {/* Both tabs stay mounted once opened, so an analysis or a selection survives switching. */}
              <div className="st-panel" role="tabpanel" id="st-panel-files" aria-labelledby="st-tab-files" hidden={tab !== "files"}>
                <FilesTab
                  key={spark.id}
                  spark={spark}
                  status={offline ? null : status}
                  readOnlyReason={offline ? `${spark.name} is offline` : null}
                  access={access}
                  scan={scan}
                  view={loc.path}
                  onView={(path, mode) => go({ path }, mode)}
                  onNotice={setNotice}
                  onDiskChanged={refreshDisks}
                />
              </div>
              {dockerSeen ? (
                <div className="st-panel" role="tabpanel" id="st-panel-docker" aria-labelledby="st-tab-docker" hidden={tab !== "docker"}>
                  {offline ? (
                    <section className="panel st-state" role="status">
                      <h2>Docker on {spark.name} cannot be read while it is offline</h2>
                      <p>Docker&rsquo;s images and containers are read live from the Spark. Nothing about them is saved here.</p>
                    </section>
                  ) : (
                    <DockerTab key={spark.id} spark={spark} peers={candidates.filter((s) => s.id !== spark.id && s.online)} access={access} onNotice={setNotice} onDiskChanged={refreshDisks} />
                  )}
                </div>
              ) : null}
            </>
          ) : null}

          <p className="st-hint st-trust">
            <b>Who can do this:</b> everyone who can open this dashboard can analyse, delete and use a remembered sudo password on
            every Spark listed here. There are no separate accounts, and Activity records what was done, not who did it.
          </p>
        </>
      )}
    </div>
  );
}

/** "You are looking at the analysis saved 3h ago." for an offline Spark, or that there is none. */
function savedNote(scan: StorageScan): string {
  if (scan.loading) return "";
  const at = scan.session ? (scan.session.analysedAt ?? scan.session.scannedAt) : null;
  if (!at) return "There is no saved analysis for it yet.";
  const age = formatSince(at, scan.serverNow());
  return `You are looking at the analysis saved ${age === "0s" ? "just now" : `${age} ago`}.`;
}
