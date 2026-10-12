import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { localizedServerText } from "../../i18n/messages";
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<ClearChoice<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; removed?: number; text?: string } | null>(null);
  const selected = pick ? choices.find((choice) => choice.id === pick.id) ?? pick : null;
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
      setMsg({ ok: true, removed: n });
      setOpen(false);
      setPick(null);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const noteText = note === "This can't be undone." ? t("ui.clearMenu.undo", "This can't be undone.") : note;
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
              <p>{selected?.ask}</p>
              <p className="ac-clear__note">{noteText}</p>
              <div className="ac-clear__row">
                <button type="button" className="btn btn--sm" onClick={() => setPick(null)} disabled={busy}>
                  {t("ui.clearMenu.cancel", "Cancel")}
                </button>
                <button type="button" className="btn btn--sm btn--danger" onClick={() => void run()} disabled={busy}>
                  {busy ? t("ui.clearMenu.deleting", "Deleting…") : t("ui.clearMenu.delete", "Delete")}
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
        {msg ? msg.ok ? msg.removed === 0 ? t("ui.clearMenu.nothing", "Nothing to delete") : msg.removed === 1 ? t("ui.clearMenu.deletedOne", "Deleted {count} event", { count: msg.removed }) : t("ui.clearMenu.deletedOther", "Deleted {count} events", { count: msg.removed }) : msg.text ? localizedServerText(msg.text) : t("ui.clearMenu.failed", "Could not delete") : null}
      </span>
    </span>
  );
}
