import { useEffect, useMemo, useRef } from "react";
import "../../styles/terminal.css";

interface LiveTerminalProps {
  lines: readonly { seq: number; text: string }[];
  /** The unfinished last line (progress bars, prompts). */
  partial?: string;
  running?: boolean;
  /** Show only the newest N lines (the full buffer is still copyable). */
  maxVisible?: number;
  className?: string;
  emptyText?: string;
}

/** Joined text of a line buffer, for display and for copy. */
export function terminalText(lines: readonly { text: string }[], partial = ""): string {
  const body = lines.map((l) => l.text).join("\n");
  return partial ? (body ? `${body}\n${partial}` : partial) : body;
}

/**
 * Read-only terminal view for streamed shell output. Sticks to the bottom while
 * output arrives, and stops following as soon as the user scrolls up to read.
 */
export function LiveTerminal({
  lines,
  partial = "",
  running = false,
  maxVisible = 1500,
  className = "",
  emptyText = "Waiting for output…",
}: LiveTerminalProps) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const shown = lines.length > maxVisible ? lines.slice(lines.length - maxVisible) : lines;
  const hidden = lines.length - shown.length;
  const text = useMemo(() => terminalText(shown, partial), [shown, partial]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      className={`live-term ${className}`}
      tabIndex={0}
      role="log"
      aria-live="off"
      aria-label="Command output"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
      }}
    >
      {hidden > 0 ? <span className="live-term__note">… {hidden.toLocaleString()} earlier lines hidden (copy gets everything)</span> : null}
      {text || (running ? emptyText : "No output.")}
      {running ? <span className="live-term__cursor" aria-hidden /> : null}
    </pre>
  );
}
