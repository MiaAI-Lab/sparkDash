import { useEffect, useRef, useState } from "react";

export interface TerminalCardProps {
  label: string;
  status: string;
  liveTokPerSec: number;
  peakTokPerSec: number;
  content: string;
  reasoning: string;
  error: string | null;
  onCopy?: () => void;
  copied?: boolean;
}

function statusClass(status: string): string {
  switch (status) {
    case "streaming":
      return "showcase-term__status--streaming";
    case "completed":
      return "showcase-term__status--completed";
    case "error":
      return "showcase-term__status--error";
    case "cancelled":
      return "showcase-term__status--cancelled";
    default:
      return "showcase-term__status--pending";
  }
}

export function TerminalCard({
  label,
  status,
  liveTokPerSec,
  peakTokPerSec,
  content,
  reasoning,
  error,
  onCopy,
  copied,
}: TerminalCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const hasReasoning = Boolean(reasoning);
  const scrollKey = `${reasoning.length}:${content.length}:${error ?? ""}`;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollKey, reasoningOpen]);

  const peak = Math.max(peakTokPerSec, liveTokPerSec, 1);
  const gaugePct = Math.min(100, (liveTokPerSec / peak) * 100);
  const empty = !content && !reasoning;

  return (
    <article className="showcase-term">
      <header className="showcase-term__header">
        <span className="showcase-term__label" title={label}>
          {label || "Terminal"}
        </span>
        <span className={`showcase-term__status ${statusClass(status)}`}>{status}</span>
        <span className="showcase-term__tps font-tabular">
          {liveTokPerSec > 0 ? `${liveTokPerSec.toFixed(0)} tok/s` : "—"}
        </span>
        {onCopy && (
          <button
            type="button"
            className="showcase-term__copy"
            onClick={onCopy}
            title="Copy this terminal"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </header>
      <div
        ref={bodyRef}
        className="showcase-term__body"
        onScroll={() => {
          const el = bodyRef.current;
          if (!el) return;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= 64;
        }}
      >
        {empty && status === "pending" && (
          <pre className="showcase-term__answer">Waiting…</pre>
        )}
        {hasReasoning && (
          <div className="showcase-term__reasoning">
            <button
              type="button"
              className="showcase-term__reasoning-toggle"
              aria-expanded={reasoningOpen}
              onClick={() => setReasoningOpen((o) => !o)}
            >
              {reasoningOpen ? "▾" : "▸"} Thinking
              <span className="showcase-term__reasoning-meta">
                {reasoning.length.toLocaleString()} chars
              </span>
            </button>
            {reasoningOpen && (
              <pre className="showcase-term__reasoning-text">{reasoning}</pre>
            )}
          </div>
        )}
        {content ? (
          <pre className="showcase-term__answer">{content}</pre>
        ) : (
          !empty && status === "streaming" && !hasReasoning && (
            <pre className="showcase-term__answer">…</pre>
          )
        )}
        {error ? <pre className="showcase-term__error">{`[error] ${error}`}</pre> : null}
      </div>
      <footer className="showcase-term__footer">
        <div className="showcase-gauge" aria-hidden="true">
          <div
            className="showcase-gauge__fill"
            style={{ ["--bar-pct" as string]: `${gaugePct}%` }}
          />
        </div>
      </footer>
    </article>
  );
}
