import { useEffect, useState } from "react";
import type { SparkSnapshot } from "../../../api/types";
import { applyPreset, countSet, emptyState, type FormState } from "./options";
import { TARGET_KEYS, matchesTemplate, simpleTemplates } from "./presets";

interface SimpleConfigProps {
  type: string;
  spark: SparkSnapshot;
  state: FormState;
  onChange: (next: FormState) => void;
  ports: number[];
  port: number;
  onAdvanced: () => void;
  apiKey: string;
  onApiKey: (key: string) => void;
}

/**
 * The Simple view: pick a ready-made run and go. Everything else lives under Advanced,
 * which shows every option the tool has.
 */
export function SimpleConfig({ type, spark, state, onChange, ports, port, onAdvanced, apiKey, onApiKey }: SimpleConfigProps) {
  const templates = simpleTemplates(type);
  const active = templates.find((t) => matchesTemplate(state, t)) ?? null;
  const tweaks = countSet(state) - [...TARGET_KEYS].filter((k) => String(state.values[k] ?? "").trim()).length;
  const custom = !active && (tweaks > 0 || type === "accuracy");
  // Test the model on this Spark, or any OpenAI-compatible URL the Spark can reach.
  const [useUrl, setUseUrl] = useState(() => String(state.values["base-url"] ?? "").trim() !== "");
  const baseUrl = String(state.values["base-url"] ?? "");
  // A re-run or restored form can bring a URL in from outside.
  useEffect(() => {
    if (baseUrl.trim()) setUseUrl(true);
  }, [baseUrl]);
  const modelName = String(state.values["model"] ?? "");
  const setTarget = (url: boolean) => {
    setUseUrl(url);
    if (!url) {
      const { ["base-url"]: _u, model: _m, ...rest } = state.values;
      onChange({ ...state, values: rest });
      onApiKey("");
    }
  };
  const setValue = (name: string, v: string) => onChange({ ...state, values: { ...state.values, [name]: v } });
  const idx = ports.indexOf(port);
  const llm = idx >= 0 ? spark.metrics.llm?.[idx] : undefined;

  const pick = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    // A template replaces the options but keeps which Spark port is being tested.
    const next = applyPreset(type, t);
    const keep = Object.fromEntries([...TARGET_KEYS].filter((k) => String(state.values[k] ?? "").trim()).map((k) => [k, state.values[k]]));
    onChange({ ...next, values: { ...next.values, ...keep }, port: state.port });
  };

  return (
    <div className="te-simple">
      <div className="te-simple__target">
        <div className="te-simple__target-head">
          <span className="eyebrow">Testing</span>
          <div className="seg" role="tablist" aria-label="What to test">
            <button type="button" role="tab" aria-selected={!useUrl} className={!useUrl ? "is-on" : ""} onClick={() => setTarget(false)}>
              Model on {spark.name}
            </button>
            <button type="button" role="tab" aria-selected={useUrl} className={useUrl ? "is-on" : ""} onClick={() => setTarget(true)}>
              Custom URL
            </button>
          </div>
        </div>
        {useUrl ? (
          <div className="te-simple__url">
            <label className="te-simple__field te-simple__field--grow">
              <span className="eyebrow">Base URL</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setValue("base-url", e.target.value)}
                placeholder="https://host/v1  or  http://192.168.1.50:8000"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Custom base URL"
              />
            </label>
            <label className="te-simple__field">
              <span className="eyebrow">Model</span>
              <input type="text" value={modelName} onChange={(e) => setValue("model", e.target.value)} placeholder="auto-detect" spellCheck={false} aria-label="Model name" />
            </label>
            <label className="te-simple__field">
              <span className="eyebrow">API key</span>
              <input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => onApiKey(e.target.value)} placeholder="if required" aria-label="API key" />
            </label>
            <p className="te-simple__hint">The run happens on {spark.name}, so it must be able to reach this URL. The key is sent to {spark.name} for this run only and is not stored here.</p>
            {!baseUrl.trim() ? <p className="te-simple__warn">Enter the URL of the OpenAI-compatible server to test.</p> : null}
          </div>
        ) : (
          <>
            <div className="te-simple__target-row">
              <b>{llm?.available && llm.modelId ? llm.modelId : "The model on this DGX Spark"}</b>
              <span className="mono">http://127.0.0.1:{port}</span>
              {ports.length > 1 ? (
                <label className="te-simple__port">
                  <span className="eyebrow">Port</span>
                  <select value={port} onChange={(e) => onChange({ ...state, port: Number(e.target.value) })} aria-label="LLM port to test">
                    {ports.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {!llm?.available ? (
              <p className="te-simple__warn">No model is answering on this port right now. Start one from the Spark's Models panel first, or switch to a custom URL.</p>
            ) : null}
          </>
        )}
      </div>

      <div className="te-simple__cards" role="radiogroup" aria-label="Ready-made runs">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active?.id === t.id}
            className={`te-simple__card${active?.id === t.id ? " is-on" : ""}`}
            onClick={() => pick(t.id)}
          >
            <span className="te-simple__card-title">{t.label}</span>
            <span className="te-simple__card-help">{t.help}</span>
            {t.size || t.time ? (
              <span className="te-simple__card-meta mono">{[t.size, t.time].filter(Boolean).join(" · ")}</span>
            ) : null}
          </button>
        ))}
      </div>

      {custom ? (
        <p className="te-simple__custom">
          Custom settings are applied.{" "}
          <button type="button" className="te-link" onClick={onAdvanced}>
            Review them in Advanced
          </button>{" "}
          or pick a template above to start fresh.
        </p>
      ) : (
        <p className="te-simple__more">
          Need more control (sampling, categories, a system prompt, other endpoints, every option)?{" "}
          <button type="button" className="te-link" onClick={onAdvanced}>
            Open Advanced
          </button>
        </p>
      )}
    </div>
  );
}

/** A Simple-view selection when the page has never been configured: the first template, so Start works right away. */
export function defaultSimpleState(type: string): FormState {
  const first = simpleTemplates(type)[0];
  return first ? applyPreset(type, first) : emptyState(type);
}
