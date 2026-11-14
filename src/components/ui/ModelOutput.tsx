import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import { LiveTerminal } from "./LiveTerminal";
import { ExpandIcon, XIcon } from "./icons";

export const AUTOSHOW_KEY = "sparkdash.llm.autoShowOutput";
function readAutoShow(): boolean {
  try { return localStorage.getItem(AUTOSHOW_KEY) !== "0"; }
  catch { return true; }
}

export function useModelOutputPreference() {
  const [autoShow, setAutoShow] = useState(readAutoShow);
  function update(value: boolean) {
    setAutoShow(value);
    try { localStorage.setItem(AUTOSHOW_KEY, value ? "1" : "0"); }
    catch { /* Session preference still applies. */ }
  }
  return [autoShow, update] as const;
}

/** Operation snapshots come from the same authenticated control status as the buttons. */
export function ModelOutput({ operationId, output, running }: {
  operationId?: string;
  output: string;
  running: boolean;
}) {
  const [autoShow, setAutoShow] = useModelOutputPreference();
  const autoShowRef = useRef(autoShow);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const previousOperation = useRef<{ id?: string; running: boolean } | null>(null);
  useEffect(() => {
    const previous = previousOperation.current;
    previousOperation.current = { id: operationId, running };
    // The dashboard's accepted UUID is replaced by the Mac's UUID during the
    // same busy interval, sometimes first observed at completion. Neither
    // handoff should reset manual viewer controls.
    if (previous && (previous.id === operationId || previous.running)) return;
    setOpen(autoShowRef.current);
    setCopied(false);
    setCopyError(null);
    setExpanded(false);
    // Respect manual Hide/Show until a different operation is observed.
  }, [operationId, running]);
  const lines = output.split("\n").map((text, seq) => ({ seq, text }));
  const hasOperation = Boolean(operationId || running || output);
  async function copy() {
    try { await navigator.clipboard.writeText(output); setCopied(true); setCopyError(null); }
    catch { setCopyError("Could not copy output. Select the terminal text to copy it manually."); }
  }
  return <div className="sp-models">
    {hasOperation && <div className="sp-job" data-testid="runtime-launcher-output">
      <div className="sp-job__bar">
        <span className="sp-job__name">{running ? "Model operation in progress" : "Model operation output"}</span>
        <div className="sp-job__tools">
          {open && <>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            <button type="button" className="sp-iconbtn" aria-label="Expand output" onClick={() => setExpanded(true)}><ExpandIcon className="h-3.5 w-3.5" /></button>
          </>}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(!open)}>{open ? "Hide output" : "Show output"}</button>
        </div>
      </div>
      {open && <LiveTerminal lines={output ? lines : []} running={running} />}
      {copyError && <p className="sp-models__error" role="alert">{copyError}</p>}
    </div>}
    <label className="sp-models__pref">
      <input type="checkbox" checked={autoShow} onChange={(event) => {
        const checked = event.target.checked;
        setAutoShow(checked);
        autoShowRef.current = checked;
      }} />
      <span>Show the output when I start or stop a model</span>
    </label>
    <TerminalModal open={expanded} title="Model operation output" lines={output ? lines : []} partial="" running={running} onClose={() => setExpanded(false)} />
  </div>;
}

export function TerminalModal({
  open,
  title,
  lines,
  partial,
  running,
  onClose,
}: {
  open: boolean;
  title: string;
  lines: { seq: number; text: string }[];
  partial: string;
  running: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("hardware");
  const { mounted, visible } = useModalPresence(open, 240);
  const overlayClose = useOverlayClose(onClose);
  // Escape closes the dialog, as it did before the output viewer moved here.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      {...overlayClose}
    >
      <div className="modal-sheet term-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title">{title}</h2>
          <button type="button" className="icon-circle ml-auto" onClick={onClose} aria-label={t("models.closeOutput")}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="modal-sheet__body term-modal__body">
          <LiveTerminal lines={lines} partial={partial} running={running} maxVisible={5000} className="live-term--tall" />
        </div>
      </div>
    </div>,
    document.body
  );
}

