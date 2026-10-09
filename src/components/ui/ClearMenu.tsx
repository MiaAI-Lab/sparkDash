import { useEffect, useRef, useState } from "react";
import "../../styles/clearmenu.css";

export interface ClearChoice<T = number | string | undefined> {
  id: string;
  label: string;
  /** Confirmation question shown before anything is deleted. */
  ask: string;
  /** Passed to onRun. */
  arg: T;
}

/** Menu button: pick what to delete, confirm in place, then run it. `onRun` resolves to the number removed. */
export function ClearMenu<T>({
  label,
  choices,
  onRun,
  disabled,
  note = "This can't be undone.",
}: {
  label: string;
  choices: readonly ClearChoice<T>[];
  onRun: (arg: T) => Promise<number>;
  disabled?: boolean;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<ClearChoice<T> | null>(null);
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
      const n = await onRun(pick.arg);
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
        {label}
      </button>
      {open ? (
        <div className="ac-clear__menu" role="menu">
          {pick ? (
            <div className="ac-clear__confirm">
              <p>{pick.ask}</p>
              <p className="ac-clear__note">{note}</p>
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
            choices.map((c) => (
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
