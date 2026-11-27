import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { authHeaders, reportAuthRequired } from "../../api/authToken";

interface Stats {
  model: string | null;
  ttftMs: number | null;
  tokens: number | null;
  tokPerSec: number | null;
  totalMs: number | null;
}

/** A one-message chat box against the local LLM (via POST /api/chat) to check it answers. */
export function ChatPage() {
  const { t } = useTranslation("chat");
  const [input, setInput] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setReply("");
    setPrompt(message);
    setStats(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = performance.now();
    let first: number | null = null;
    let model: string | null = null;
    let tokens: number | null = null;
    let text = "";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ message }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        if (res.status === 401) reportAuthRequired();
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            if (j.model) model = j.model;
            if (j.usage?.completion_tokens != null) tokens = j.usage.completion_tokens;
            const piece: string = j.choices?.[0]?.delta?.content ?? "";
            if (piece) {
              if (first === null) first = performance.now();
              text += piece;
              setReply(text);
            }
          } catch {
            /* partial or non-JSON line */
          }
        }
      }
      const end = performance.now();
      const decodeSec = first !== null ? (end - first) / 1000 : 0;
      setStats({
        model,
        ttftMs: first !== null ? first - t0 : null,
        tokens,
        tokPerSec: tokens && tokens > 1 && decodeSec > 0 ? (tokens - 1) / decodeSec : null,
        totalMs: end - t0,
      });
      setInput("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, busy]);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="text-sm opacity-70">{t("description")}</p>
      </header>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          className="chat-input min-h-[4rem] w-full min-w-0 flex-1 rounded-md p-2"
          value={input}
          placeholder={t("placeholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label={t("messageAria")}
        />
        {busy ? (
          <button type="button" className="btn btn--sm" onClick={() => abortRef.current?.abort()}>
            {t("stop")}
          </button>
        ) : (
          <button type="submit" className="btn btn--sm" disabled={!input.trim()}>
            {t("send")}
          </button>
        )}
      </form>
      {error ? <div className="rounded-md border border-red-500/50 p-2 text-sm text-red-500">{error}</div> : null}
      {prompt ? (
        <section className="flex min-w-0 flex-col gap-2 rounded-md border border-current/20 p-3 text-sm [overflow-wrap:anywhere]" aria-live="polite">
          <div className="whitespace-pre-wrap break-words opacity-70">{t("you", { prompt })}</div>
          <div className="whitespace-pre-wrap break-words">{reply || (busy ? t("waiting") : "")}</div>
          {stats ? (
            <div className="break-words font-mono text-xs opacity-70" data-testid="chat-stats">
              {t("stats", {
                model: stats.model ?? t("unknown"),
                ttft: stats.ttftMs != null ? t("ttftMs", { ms: Math.round(stats.ttftMs) }) : t("unknown"),
                tokens: stats.tokens ?? t("unknown"),
                rate: stats.tokPerSec != null ? t("tokPerSec", { value: stats.tokPerSec.toFixed(1) }) : t("tokPerSecUnknown"),
                total: stats.totalMs != null ? t("totalSec", { value: (stats.totalMs / 1000).toFixed(2) }) : t("unknown"),
              })}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
