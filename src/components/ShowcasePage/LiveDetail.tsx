import { useEffect, useRef, useState } from "react";

/**
 * Full-screen view of one live request (F720): the conversation it carried (its history — system
 * prompt collapsed, every user / assistant / tool turn) and the current answer streaming in at the
 * bottom. "← Back" returns to the terminal grid exactly where the pop-out happened.
 */
type Turn = {
  role: string;
  chars: number;
  text: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { name: string; args: string }[];
  reasoning?: string;
};

type Detail = {
  id: number;
  client: string;
  model?: string;
  status: string;
  n_messages?: number;
  stream?: boolean;
  out_text?: string;
  reasoning_text?: string;
  out_text_len?: number;
  reasoning_text_len?: number;
  finish?: string | null;
  out_tokens?: number | null;
  tok_s?: number | null;
  tok_s_live?: number | null;
  ttft?: number | null;
  wall?: number;
  elapsed?: number;
  thinking?: boolean | null;
  effort?: string | null;
  transcript?: Turn[] | null;
  error?: string;
};

export function LiveDetail({
  sparkId,
  reqId,
  who,
  onBack,
}: {
  sparkId: string;
  reqId: number;
  who: (ip: string) => string;
  onBack: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await fetch(`/api/sparks/${encodeURIComponent(sparkId)}/llm/live-requests/${reqId}`);
        const j = (await r.json()) as Detail;
        if (!cancelled) {
          setD(j);
          setErr(j.error ?? null);
        }
        const live = j.status === "streaming" || j.status === "prefill";
        timer = setTimeout(tick, live ? 700 : 4000);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error)?.message ?? e));
        timer = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sparkId, reqId]);

  useEffect(() => {
    const el = outRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [d?.out_text?.length, d?.reasoning_text?.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const live = d ? d.status === "streaming" || d.status === "prefill" : false;
  const turns = d?.transcript ?? [];
  const system = turns.filter((t) => t.role === "system");
  const conv = turns.filter((t) => t.role !== "system");

  return (
    <div className="live-detail" role="dialog" aria-modal="true">
      <header className="live-detail__bar">
        <button type="button" className="showcase-btn showcase-btn--primary" onClick={onBack} title="Back to the live terminals (Esc)">
          ← Back
        </button>
        <span className="live-detail__title">
          {d ? `${who(d.client)} → ${d.model ?? "?"}` : "loading…"}
        </span>
        <span className="live-detail__meta">
          {d && (
            <>
              <span className={`showcase-term__status ${live ? "showcase-term__status--streaming" : d.status === "done" ? "showcase-term__status--completed" : "showcase-term__status--cancelled"}`}>
                {live ? d.status : (d.finish ?? d.status)}
              </span>
              {" · "}
              {d.n_messages ?? conv.length} messages in this inquiry
              {d.thinking != null ? ` · thinking ${d.thinking ? "on" : "off"}${d.effort ? `/${d.effort}` : ""}` : ""}
              {d.out_tokens != null ? ` · ${d.out_tokens} tok out` : ""}
              {live && d.tok_s_live ? ` · ${d.tok_s_live} tok/s` : d.tok_s ? ` · ${d.tok_s} tok/s` : ""}
              {d.ttft != null ? ` · ttft ${d.ttft}s` : ""}
              {live ? ` · ${Math.round(d.elapsed ?? 0)}s` : d.wall != null ? ` · ${d.wall}s` : ""}
            </>
          )}
          {err ? ` · ${err}` : ""}
        </span>
      </header>

      <div
        ref={outRef}
        className="live-detail__body"
        onScroll={() => {
          const el = outRef.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
        }}
      >
        {!d?.transcript && d && (
          <p className="showcase-history__empty">History for this request is no longer held by the tap (it keeps the last 80). The current output is below.</p>
        )}
        {system.length > 0 && (
          <section className="live-turn live-turn--system">
            <button type="button" className="showcase-term__reasoning-toggle" onClick={() => setShowSystem((v) => !v)} aria-expanded={showSystem}>
              {showSystem ? "▾" : "▸"} System prompt
              <span className="showcase-term__reasoning-meta">{system.reduce((a, t) => a + t.chars, 0).toLocaleString()} chars</span>
            </button>
            {showSystem && system.map((t, i) => <pre key={i} className="live-turn__text">{t.text}{t.chars > t.text.length ? "\n…[truncated]" : ""}</pre>)}
          </section>
        )}
        {conv.map((t, i) => (
          <section key={i} className={`live-turn live-turn--${t.role}`}>
            <div className="live-turn__role">
              {t.role === "user" ? "USER ▶" : t.role === "assistant" ? "ASSISTANT ◀" : t.role === "tool" ? `TOOL RESULT${t.name ? ` · ${t.name}` : ""}` : t.role.toUpperCase()}
            </div>
            {t.reasoning && <pre className="live-turn__reasoning">{t.reasoning}</pre>}
            {t.text && <pre className="live-turn__text">{t.text}{t.chars > t.text.length ? `\n…[+${(t.chars - t.text.length).toLocaleString()} chars]` : ""}</pre>}
            {t.tool_calls?.map((c, j) => (
              <pre key={j} className="live-turn__toolcall">⚙ {c.name}({c.args})</pre>
            ))}
          </section>
        ))}
        <section className={`live-turn live-turn--assistant live-turn--current${live ? " is-live" : ""}`}>
          <div className="live-turn__role">
            {live ? "ASSISTANT ◀ streaming now…" : `ASSISTANT ◀ current answer${d?.finish ? ` (${d.finish})` : ""}`}
          </div>
          {d?.reasoning_text && (
            <details open className="live-turn__thinking">
              <summary>Thinking · {(d.reasoning_text_len ?? d.reasoning_text.length).toLocaleString()} chars</summary>
              <pre className="live-turn__reasoning">{d.reasoning_text}</pre>
            </details>
          )}
          <pre className="live-turn__text live-turn__text--out">
            {d?.out_text || (live ? "…" : d?.error ? `[error] ${d.error}` : "[no text — tool call or empty]")}
            {live && <span className="live-cursor">▍</span>}
          </pre>
        </section>
      </div>
    </div>
  );
}
