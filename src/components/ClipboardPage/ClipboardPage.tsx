import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  clearClipboard,
  createClipboardEntry,
  deleteClipboardEntry,
  fetchClipboard,
  fetchClipboardHistory,
  fetchClipboardPart,
  fetchClipboardText,
  shareClipboardText,
  uploadClipboardPart,
  type ClipboardEntry,
  type ClipboardLimits,
  type ClipboardPart,
} from "../../api/clipboardClient";
import { useClipboardRevision } from "../../hooks/clipboardRevision";
import { formatBytes } from "../../shared/formatBytes";
import { ClearMenu } from "../ui/ClearMenu";
import { ClipboardIcon, CopyIcon, DownloadIcon, FileIcon, ImageIcon, TrashIcon } from "../ui/icons";
import { agoOf, checkFilesLimit, checkTextLimit, entryTypeFor, filesFrom, legacyCopy, saveBlob, type LimitProblem } from "./clipboardFormat";
import "../../styles/tokens.css";
import "../../styles/clipboard.css";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Notice = { ok: boolean; text: string } | null;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function limitText(t: Translate, problem: LimitProblem): string {
  switch (problem.kind) {
    case "textTooLarge": return t("limits.text", { limit: formatBytes(problem.limit) });
    case "tooManyParts": return t("limits.parts", { limit: problem.limit });
    case "partTooLarge": return t("limits.part", { name: problem.name, limit: formatBytes(problem.limit) });
    case "entryTooLarge": return t("limits.entry", { limit: formatBytes(problem.limit) });
  }
}

function agoText(t: Translate, createdAt: number, now: number): string {
  const ago = agoOf(createdAt, now);
  switch (ago.unit) {
    case "now": return t("ago.now");
    case "min": return t("ago.minutes", { count: ago.count });
    case "hour": return t("ago.hours", { count: ago.count });
    case "day": return t("ago.days", { count: ago.count });
  }
}

function sourceText(t: Translate, entry: ClipboardEntry): string {
  if (entry.source.kind === "device") return entry.source.device ?? t("source.device");
  return t("source.browser");
}

function typeText(t: Translate, entry: ClipboardEntry): string {
  switch (entry.type) {
    case "text": return t("type.text");
    case "image": return t("type.image");
    case "files": return t("type.files", { count: entry.parts.length });
  }
}

function TypeIcon({ type }: { type: ClipboardEntry["type"] }) {
  if (type === "image") return <ImageIcon className="h-4 w-4" />;
  if (type === "files") return <FileIcon className="h-4 w-4" />;
  return <ClipboardIcon className="h-4 w-4" />;
}

/** <img> cannot send the bearer header, so the bytes come through an authed fetch and an object URL. */
function PartImage({ entryId, part, className, alt }: { entryId: string; part: ClipboardPart; className: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    fetchClipboardPart(entryId, part.id)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entryId, part.id]);
  return url ? <img src={url} alt={alt} className={className} /> : <span className={`${className} cb-img--pending`} aria-hidden />;
}

function PartList({ parts }: { parts: ClipboardPart[] }) {
  return (
    <ul className="cb-parts">
      {parts.map((p) => (
        <li key={p.id}>
          <FileIcon className="h-3.5 w-3.5" />
          <span className="cb-parts__name">{p.name}</span>
          <span className="cb-parts__size">{formatBytes(p.size)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ClipboardPage() {
  const { t } = useTranslation("clipboard");
  const wsRevision = useClipboardRevision();
  const [latest, setLatest] = useState<ClipboardEntry | null>(null);
  const [entries, setEntries] = useState<ClipboardEntry[] | null>(null);
  const [limits, setLimits] = useState<ClipboardLimits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [now, setNow] = useState(() => Date.now());
  const loadedRevision = useRef<number | null>(null);
  const loadSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const [state, history] = await Promise.all([fetchClipboard(), fetchClipboardHistory()]);
      if (seq !== loadSeq.current) return;
      setLatest(state.latest);
      setLimits(state.limits);
      setEntries(history.entries);
      setLoadError(null);
      loadedRevision.current = Math.max(state.revision, history.revision);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(errorText(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loadedRevision.current != null && (wsRevision == null || wsRevision === loadedRevision.current)) return;
    void load();
  }, [wsRevision, load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const run = useCallback(
    async (action: () => Promise<string | null>, reload = true) => {
      setBusy(true);
      try {
        const done = await action();
        if (done) setNotice({ ok: true, text: done });
        if (reload) await load();
      } catch (err) {
        setNotice({ ok: false, text: errorText(err) });
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const shareText = useCallback(
    (text: string, fromDraft: boolean) => {
      if (!text) return;
      const problem = checkTextLimit(text, limits);
      if (problem) {
        setNotice({ ok: false, text: limitText(t, problem) });
        return;
      }
      void run(async () => {
        const res = await shareClipboardText(text);
        if (fromDraft) setDraft("");
        return res.duplicate ? t("notice.duplicate") : t("notice.shared");
      });
    },
    [limits, run, t]
  );

  const shareFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const problem = checkFilesLimit(files, limits);
      if (problem) {
        setNotice({ ok: false, text: limitText(t, problem) });
        return;
      }
      void run(async () => {
        const ids: string[] = [];
        for (const file of files) ids.push((await uploadClipboardPart(file, file.name || "clipboard")).upload.id);
        await createClipboardEntry(ids, entryTypeFor(files));
        return t("notice.shared");
      });
    },
    [limits, run, t]
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      if (target?.closest?.("[role=dialog]")) return;
      if (busy) return;
      const files = filesFrom(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        shareFiles(files);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        e.preventDefault();
        shareText(text, false);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [busy, shareFiles, shareText]);

  const copyEntry = (entry: ClipboardEntry) =>
    void run(async () => {
      if (entry.type === "text") {
        const text = entry.textTruncated || entry.textPreview == null ? await fetchClipboardText(entry.id) : entry.textPreview;
        const copied = navigator.clipboard?.writeText
          ? await navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text))
          : legacyCopy(text);
        if (!copied) throw new Error(t("notice.copyFailed"));
        return t("notice.copied");
      }
      const part = entry.parts[0];
      if (!part) return null;
      const blob = await fetchClipboardPart(entry.id, part.id);
      const canWriteImage = typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
      if (canWriteImage && blob.type === "image/png") {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return t("notice.copied");
      }
      saveBlob(blob, part.name);
      return t("notice.downloaded");
    }, false);

  const downloadParts = (entry: ClipboardEntry) =>
    void run(async () => {
      for (const part of entry.parts) saveBlob(await fetchClipboardPart(entry.id, part.id), part.name);
      return t("notice.downloaded");
    }, false);

  const removeEntry = (entry: ClipboardEntry) =>
    void run(async () => {
      await deleteClipboardEntry(entry.id);
      return t("notice.deleted");
    });

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (!busy) shareFiles(filesFrom(e.dataTransfer));
  };

  const onDraftPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFrom(e.clipboardData);
    if (!files.length || busy) return;
    e.preventDefault();
    shareFiles(files);
  };

  const actions = (entry: ClipboardEntry) => (
    <div className="cb-actions">
      {entry.type !== "files" ? (
        <button type="button" className="btn btn--sm" onClick={() => copyEntry(entry)} disabled={busy} aria-label={t("actions.copyLabel", { type: typeText(t, entry) })}>
          <CopyIcon className="h-3.5 w-3.5" />
          <span>{t("actions.copy")}</span>
        </button>
      ) : null}
      {entry.parts.length ? (
        <button type="button" className="btn btn--sm" onClick={() => downloadParts(entry)} disabled={busy} aria-label={t("actions.downloadLabel", { type: typeText(t, entry) })}>
          <DownloadIcon className="h-3.5 w-3.5" />
          <span>{t("actions.download")}</span>
        </button>
      ) : null}
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => removeEntry(entry)} disabled={busy} aria-label={t("actions.deleteLabel", { type: typeText(t, entry) })}>
        <TrashIcon className="h-3.5 w-3.5" />
        <span>{t("actions.delete")}</span>
      </button>
    </div>
  );

  const meta = (entry: ClipboardEntry) => (
    <span className="cb-meta">
      <span>{typeText(t, entry)}</span>
      <span>{formatBytes(entry.size)}</span>
      <span>{sourceText(t, entry)}</span>
      <time dateTime={new Date(entry.createdAt).toISOString()} title={new Date(entry.createdAt).toLocaleString()}>
        {agoText(t, entry.createdAt, now)}
      </time>
    </span>
  );

  return (
    <div className="tk cb">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-head__sub">{t("subtitle")}</p>
        </div>
        <div className="page-head__tools">
          <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
            {loading ? t("refreshing") : t("refresh")}
          </button>
        </div>
      </header>

      {loadError ? (
        <div className="panel tk-note tk-note--err" role="alert">
          {t("errors.load", { error: loadError })}
        </div>
      ) : null}

      <section className="panel tk-card cb-latest" aria-labelledby="cb-latest-title">
        <div className="tk-card__head">
          <h2 id="cb-latest-title" className="tk-card__title">
            {t("latest.title")}
          </h2>
          {latest ? meta(latest) : null}
        </div>
        {latest ? (
          <>
            {latest.type === "text" ? (
              <>
                <pre className="cb-text">{latest.textPreview ?? ""}</pre>
                {latest.textTruncated ? <p className="tk-card__sub">{t("latest.truncated", { size: formatBytes(latest.textSize) })}</p> : null}
              </>
            ) : latest.type === "image" && latest.parts[0] ? (
              <PartImage entryId={latest.id} part={latest.parts[0]} className="cb-img" alt={latest.parts[0].name} />
            ) : (
              <PartList parts={latest.parts} />
            )}
            {actions(latest)}
          </>
        ) : (
          <p className="tk-card__sub">{loading && !entries ? t("loading") : t("latest.empty")}</p>
        )}
      </section>

      <section className="panel tk-card" aria-labelledby="cb-share-title">
        <div className="tk-card__head">
          <h2 id="cb-share-title" className="tk-card__title">
            {t("share.title")}
          </h2>
          {notice ? (
            <span className={`tk-copymsg${notice.ok ? "" : " is-err"}`} role={notice.ok ? "status" : "alert"}>
              {notice.text}
            </span>
          ) : null}
        </div>
        <form
          className="cb-share"
          onSubmit={(e) => {
            e.preventDefault();
            shareText(draft, true);
          }}
        >
          <label htmlFor="cb-draft" className="tk-sr">
            {t("share.textLabel")}
          </label>
          <textarea
            id="cb-draft"
            className="cb-draft"
            value={draft}
            placeholder={t("share.placeholder")}
            rows={4}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onDraftPaste}
          />
          <div className="cb-share__row">
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !draft}>
              {t("share.text")}
            </button>
          </div>
        </form>
        <div
          className={`cb-drop${dragging ? " is-dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>{t("share.drop")}</p>
          <button type="button" className="btn btn--sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            {t("share.choose")}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="tk-sr"
            tabIndex={-1}
            aria-label={t("share.choose")}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              shareFiles(files);
            }}
          />
          {limits ? (
            <p className="cb-hint">
              {t("share.limits", { parts: limits.maxParts, part: formatBytes(limits.maxPartBytes), text: formatBytes(limits.maxTextBytes) })}
            </p>
          ) : null}
          <p className="cb-hint">{t("share.pasteHint")}</p>
        </div>
      </section>

      <section className="panel tk-card" aria-labelledby="cb-history-title">
        <div className="tk-card__head">
          <h2 id="cb-history-title" className="tk-card__title">
            {t("history.title")}
          </h2>
          <ClearMenu
            label={t("history.clear")}
            disabled={!entries?.length || busy}
            choices={[{ id: "all", label: t("history.clearAll"), ask: t("history.clearAsk"), arg: undefined }]}
            onRun={async () => {
              const res = await clearClipboard();
              await load();
              return res.removed;
            }}
            copy={{
              cancel: t("history.cancel"),
              delete: t("history.confirm"),
              deleting: t("history.deleting"),
              irreversible: t("history.irreversible"),
              nothing: t("history.nothing"),
              deleted: (count) => t("history.cleared", { count }),
              failed: t("history.failed"),
            }}
          />
        </div>
        {entries == null ? (
          loading ? <p className="tk-card__sub">{t("loading")}</p> : null
        ) : entries.length === 0 ? (
          <p className="tk-card__sub">{t("history.empty")}</p>
        ) : (
          <ul className="cb-list">
            {entries.map((entry) => (
              <li key={entry.id} className="cb-row">
                <span className="cb-row__icon">
                  <TypeIcon type={entry.type} />
                </span>
                <div className="cb-row__body">
                  {entry.type === "text" ? (
                    <span className="cb-row__text">{entry.textPreview ?? ""}</span>
                  ) : entry.type === "image" && entry.parts[0] ? (
                    <PartImage entryId={entry.id} part={entry.parts[0]} className="cb-thumb" alt={entry.parts[0].name} />
                  ) : (
                    <span className="cb-row__text">{entry.parts.map((p) => p.name).join(", ")}</span>
                  )}
                  {meta(entry)}
                </div>
                {actions(entry)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
