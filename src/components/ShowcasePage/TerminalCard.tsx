import { useEffect, useRef, useState } from "react";

/**
 * Reveals `target` smoothly instead of in the lumps the network delivers it in.
 * A frame loop chases the target: the further behind it is, the faster it moves
 * (exponential catch-up), with a small floor so slow streams still flow. When the
 * stream is over it drains quickly. A card opened on finished text shows it at once.
 */
export function useSmoothText(target: string, live: boolean): string {
  const [shown, setShown] = useState(() => (live ? 0 : target.length));
  const pos = useRef(live ? 0 : target.length);
  const latest = useRef({ target, live });
  latest.current = { target, live };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      pos.current = target.length;
      setShown(target.length);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
      last = now;
      const { target: t, live: l } = latest.current;
      if (pos.current > t.length) pos.current = t.length; // text was replaced by something shorter
      const backlog = t.length - pos.current;
      if (backlog > 0) {
        const tau = l ? 0.5 : 0.07;
        const floor = l ? 28 : 600; // chars/s: slow streams keep moving, finished ones drain fast
        pos.current = Math.min(t.length, pos.current + Math.max(backlog * (1 - Math.exp(-dt / tau)), floor * dt));
        let n = Math.floor(pos.current);
        const c = t.charCodeAt(n - 1);
        if (c >= 0xd800 && c <= 0xdbff) n -= 1; // never cut a surrogate pair
        setShown((prev) => (prev === n ? prev : n));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return shown >= target.length ? target : target.slice(0, shown);
}

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
  const streaming = status === "streaming" || status === "pending";
  const shownContent = useSmoothText(content, streaming);
  const shownReasoning = useSmoothText(reasoning, streaming);
  const typing = shownContent.length < content.length || shownReasoning.length < reasoning.length;
  const scrollKey = `${shownReasoning.length}:${shownContent.length}:${error ?? ""}`;

  // Reasoning opens by itself while the model is thinking and folds away once the answer
  // shows (unless the user toggled it). A new run in the same card starts open again.
  const answerStarted = shownContent.length > 0;
  const thinking = streaming && !answerStarted;
  useEffect(() => {
    if (thinking) {
      reasoningTouched.current = false;
      setReasoningOpen(true);
    }
  }, [thinking]);
  useEffect(() => {
    if (answerStarted && !reasoningTouched.current) setReasoningOpen(false);
  }, [answerStarted]);
  useEffect(() => {
    // Reasoning text arriving while the card is folded (e.g. a second reasoning phase before any answer).
    if (hasReasoning && thinking && !reasoningTouched.current) setReasoningOpen(true);
  }, [hasReasoning, thinking]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollKey, reasoningOpen]);

  const peak = Math.max(peakTokPerSec, liveTokPerSec, 1);
  const gaugePct = Math.min(100, (liveTokPerSec / peak) * 100);
  const empty = !content && !reasoning;

  return (
    <article className="showcase-term" data-status={status}>
      <header className="showcase-term__header">
        <span className="showcase-term__dot" aria-hidden />
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
              <pre className="showcase-term__reasoning-text">{shownReasoning}</pre>
            )}
          </div>
        )}
        {content ? (
          <pre className="showcase-term__answer">
            {shownContent}
            {(streaming || typing) && <span className="showcase-term__caret" aria-hidden />}
          </pre>
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
