import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ToolEvalLine } from "../../../api/types";
import { AlertTriangleIcon, CheckIcon, InfoIcon } from "../../ui/icons";

/** Copy text to the clipboard with a short "Copied" confirmation. */
export function CopyButton({ text, label = "Copy", className = "" }: { text: string | (() => string); label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    const value = typeof text === "function" ? text() : text;
    try {
      await navigator.clipboard.writeText(value);
      setState("ok");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.className = "te-offscreen";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        setState("ok");
      } catch {
        setState("err");
      }
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  };
  return (
    <button type="button" className={`btn btn--sm btn--ghost ${className}`} onClick={copy} aria-live="polite">
      {state === "ok" ? (
        <>
          <CheckIcon className="h-3.5 w-3.5" /> Copied
        </>
      ) : state === "err" ? (
        "Copy failed"
      ) : (
        label
      )}
    </button>
  );
}

/** Collapsible pretty-printed JSON with Copy. */
export function JsonDisclosure({ value, title = "Raw JSON", defaultOpen = false }: { value: unknown; title?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const text = open ? safeStringify(value) : "";
  return (
    <details className="te-disclosure" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span>{title}</span>
        <span className="te-faint">{open ? "" : "show"}</span>
      </summary>
      {open ? (
        <div className="te-json">
          <div className="te-json__bar">
            <CopyButton text={() => safeStringify(value)} label="Copy JSON" />
          </div>
          <pre>{text}</pre>
        </div>
      ) : null}
    </details>
  );
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

export function Notice({ tone = "info", title, children, actions }: { tone?: "info" | "warn" | "bad" | "good"; title?: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`te-notice te-notice--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {tone === "info" || tone === "good" ? <InfoIcon className="te-notice__icon" /> : <AlertTriangleIcon className="te-notice__icon" />}
      <div className="te-notice__body">
        {title ? <b>{title}</b> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {actions ? <div className="te-notice__actions">{actions}</div> : null}
    </div>
  );
}

export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`te-skel ${className}`} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} className="te-skel__line" data-w={i % 3} />
      ))}
    </div>
  );
}

/** Streamed output with stderr lines dimmed; sticks to the bottom until the reader scrolls up. */
export function RunTerminal({ lines, partial = "", running, maxVisible = 1500 }: { lines: readonly ToolEvalLine[]; partial?: string; running?: boolean; maxVisible?: number }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const shown = lines.length > maxVisible ? lines.slice(lines.length - maxVisible) : lines;
  const last = lines.length ? lines[lines.length - 1].seq : 0;
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last, partial]);
  return (
    <pre
      ref={ref}
      className="live-term te-term"
      tabIndex={0}
      role="log"
      aria-label="Raw tool output"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
      }}
    >
      {lines.length > shown.length ? <span className="live-term__note">… {(lines.length - shown.length).toLocaleString()} earlier lines hidden (copy gets everything)</span> : null}
      {shown.map((l) => (
        <span key={l.seq} className={l.stream === "err" ? "te-term__err" : undefined}>
          {l.text}
          {"\n"}
        </span>
      ))}
      {partial}
      {!shown.length && !partial ? (running ? "Waiting for output…" : "No output.") : null}
      {running ? <span className="live-term__cursor" aria-hidden /> : null}
    </pre>
  );
}

export const linesText = (lines: readonly { text: string }[], partial = "") => lines.map((l) => l.text).join("\n") + (partial ? `\n${partial}` : "");
