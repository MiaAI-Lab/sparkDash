import { useEffect, useRef, useState } from "react";

const DAY = 86_400_000;
const CHOICES = [
  { id: "7d", label: "Older than 7 days", ms: 7 * DAY, ask: "Delete events older than 7 days?" },
  { id: "24h", label: "Older than 24 hours", ms: DAY, ask: "Delete events older than 24 hours?" },
  { id: "all", label: "Everything", ms: undefined, ask: "Delete the whole activity history?" },
] as const;

/** "Clear history" menu: pick a range, confirm in place, then the server deletes it. */
export function ClearHistory({
  onClear,
  disabled,
}: {
  onClear: (olderThanMs?: number) => Promise<number>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<(typeof CHOICES)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setPick(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPick(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const run = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      const n = await onClear(pick.ms);
      setMsg({ ok: true, text: n === 0 ? "Nothing to delete" : `Deleted ${n} event${n === 1 ? "" : "s"}` });
      setOpen(false);
      setPick(null);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not delete" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="ac-clear" ref={root}>
      <button
        type="button"
        className="btn btn--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setPick(null);
        }}
      >
        Clear history…
      </button>
      {open ? (
        <div className="ac-clear__menu" role="menu">
          {pick ? (
            <div className="ac-clear__confirm">
              <p>{pick.ask}</p>
              <p className="ac-clear__note">This can't be undone.</p>
              <div className="ac-clear__row">
                <button type="button" className="btn btn--sm" onClick={() => setPick(null)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="btn btn--sm btn--danger" onClick={() => void run()} disabled={busy}>
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          ) : (
            CHOICES.map((c) => (
              <button key={c.id} type="button" role="menuitem" className="ac-clear__item" onClick={() => setPick(c)}>
                {c.label}
              </button>
            ))
          )}
        </div>
      ) : null}
      <span className={`ac-toast${msg ? (msg.ok ? " is-ok" : " is-err") : ""}`} role="status" aria-live="polite">
        {msg?.text}
      </span>
    </span>
  );
}
