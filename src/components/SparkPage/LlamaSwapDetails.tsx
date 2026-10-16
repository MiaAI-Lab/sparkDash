import type { LlamaSwapInfo } from "../../api/types";
import { backendLabel } from "../../shared/llmBackends.js";
import { formatSince } from "../../shared/formatSince";
import { Tag, type TagTone } from "../ui/Tag";

const STATE_TONE: Record<string, TagTone> = {
  ready: "good",
  loaded: "good",
  starting: "warn",
  stopping: "warn",
};

function fmtRate(n: number | null): string | null {
  if (n == null) return null;
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * llama-swap block of an LLM panel: which model IDs it can start and their
 * state, which engine the loaded one runs on, and the last request it
 * completed (from llama-swap's own Activity log, so it covers engines that
 * publish no live counters).
 */
export function LlamaSwapDetails({ info, now = Date.now() }: { info: LlamaSwapInfo; now?: number }) {
  const last = info.lastRequest;
  const lastParts = last
    ? [
        fmtRate(last.decodeTps) && `${fmtRate(last.decodeTps)} tok/s decode`,
        fmtRate(last.prefillTps) && `${fmtRate(last.prefillTps)} tok/s prefill`,
        last.outputTokens > 0 && `${last.outputTokens.toLocaleString()} out`,
      ].filter(Boolean)
    : [];
  const lastAgo = last?.at != null ? formatSince(last.at, now) : null;
  const engine = info.engine;
  const engineName = engine?.backend ? backendLabel(engine.backend) ?? engine.backend : null;

  return (
    <div className="sp-stack" data-llama-swap>
      {engine && (
        <p className="sp-hint" title={engine.url}>
          {engine.available
            ? `Engine: ${engineName ?? "OpenAI-compatible"} at ${engine.url}`
            : `Engine at ${engine.url} is not reachable from here; showing llama-swap Activity only`}
        </p>
      )}
      {info.models.length > 0 && (
        <div className="sp-chips" aria-label="llama-swap models">
          {info.models.map((m) => (
            <Tag key={m.id} tone={STATE_TONE[m.state] ?? "neutral"} title={`${m.name ?? m.id} · ${m.state}`}>
              {m.id} · {m.state === "ready" ? "loaded" : m.state}
            </Tag>
          ))}
        </div>
      )}
      {last && (
        <p className="sp-hint" data-llama-swap-last title={last.model ?? undefined}>
          Last request{last.model ? ` (${last.model})` : ""}
          {lastParts.length ? `: ${lastParts.join(" · ")}` : ""}
          {lastAgo ? ` · ${lastAgo} ago` : ""}
        </p>
      )}
      {!info.activity && (
        <p className="sp-hint">This llama-swap has no Activity API, so token totals and the last request are not shown.</p>
      )}
    </div>
  );
}
