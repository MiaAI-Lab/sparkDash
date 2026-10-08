import { useEffect, useRef, useState } from "react";

export interface TerminalCardProps {
  label: string;
  status: string;
  liveTokPerSec: number;
  peakTokPerSec: number;
  /** Tokens generated so far by this stream (shown in the header). */
  tokenCount?: number;
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
  tokenCount,
  content,
  reasoning,
  error,
  onCopy,
  copied,
}: TerminalCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const reasoningTouched = useRef(false);
  const hasReasoning = Boolean(reasoning);
  const scrollKey = `${reasoning.length}:${content.length}:${error ?? ""}`;

  // Fold the reasoning away once the answer starts, unless the user toggled it.
  const answerStarted = content.length > 0;
  useEffect(() => {
    if (answerStarted && !reasoningTouched.current) setReasoningOpen(false);
  }, [answerStarted]);

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
        {tokenCount != null && tokenCount > 0 && (
          <span className="showcase-term__tokens font-tabular">{tokenCount.toLocaleString()} tokens</span>
        )}
        <span
          className="showcase-term__tps font-tabular"
          title={
            peakTokPerSec > 0 || liveTokPerSec > 0
              ? `Live ${liveTokPerSec.toFixed(1)} tok/s · peak ${Math.max(peakTokPerSec, liveTokPerSec).toFixed(1)} tok/s`
              : undefined
          }
        >
          {liveTokPerSec > 0 || peakTokPerSec > 0 ? (
            <>
              {(liveTokPerSec > 0 ? liveTokPerSec : peakTokPerSec).toFixed(0)} tok/s
              {peakTokPerSec > 0 && (
                <span className="showcase-term__tps-peak">
                  {" "}
                  peak {Math.max(peakTokPerSec, liveTokPerSec).toFixed(0)}
                </span>
              )}
            </>
          ) : (
            "—"
          )}
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
              onClick={() => {
                reasoningTouched.current = true;
                setReasoningOpen((o) => !o);
              }}
            >
              {reasoningOpen ? "▾" : "▸"} Reasoning
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
