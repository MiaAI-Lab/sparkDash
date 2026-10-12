import { t } from "../../../i18n";
import { useEffect, useId } from "react";
import type { SparkSnapshot } from "../../../api/types";
import { applyPreset, countSet, emptyState, type FormState } from "./options";
import { TrialsRow } from "./TrialsRow";
import { onRovingKeyDown } from "./a11y";
import { KEPT_KEYS, keptValues, matchesTemplate, simpleTemplates } from "./presets";
import { Tabs, panelId, tabId } from "./Tabs";

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
  /** Custom-URL target mode; owned by the page so it stays in step with the API key. */
  useUrl: boolean;
  onUseUrl: (useUrl: boolean) => void;
}

/**
 * The Simple view: pick a ready-made run and go. Everything else lives under Advanced,
 * which shows every option the tool has.
 */
export function SimpleConfig({ type, spark, state, onChange, ports, port, onAdvanced, apiKey, onApiKey, useUrl, onUseUrl: setUseUrl }: SimpleConfigProps) {
  const templates = simpleTemplates(type);
  const active = templates.find((t) => matchesTemplate(state, t)) ?? null;
  const tweaks = countSet(state) - [...KEPT_KEYS].filter((k) => String(state.values[k] ?? "").trim()).length;
  const custom = !active && (tweaks > 0 || type === "accuracy");
  // Test the model on this Spark, or any OpenAI-compatible URL the Spark can reach.
  const uid = useId();
  const baseUrl = String(state.values["base-url"] ?? "");
  // A re-run or restored form can bring a URL in from outside.
  useEffect(() => {
    if (baseUrl.trim()) setUseUrl(true);
  }, [baseUrl, setUseUrl]);
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
    const keep = keptValues(state.values);
    onChange({ ...next, values: { ...next.values, ...keep }, port: state.port });
  };

  return (
    <div className="te-simple">
      <div className="te-simple__target">
        <div className="te-simple__target-head">
          <span className="eyebrow">{t("bench.testing")}</span>
          <Tabs
            prefix={uid}
            label={t("bench.what_to_test_3e4e_2")}
            value={useUrl ? "url" : "local"}
            onChange={(v) => setTarget(v === "url")}
            items={[
              { id: "local", label: t("bench.model_on", { spark: spark.name }) },
              { id: "url", label: t("bench.custom_url") },
            ]}
          />
        </div>
        <div role="tabpanel" id={panelId(uid, useUrl ? "url" : "local")} aria-labelledby={tabId(uid, useUrl ? "url" : "local")}>
        {useUrl ? (
          <div className="te-simple__url">
            <label className="te-simple__field te-simple__field--grow">
              <span className="eyebrow">{t("bench.base_url")}</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setValue("base-url", e.target.value)}
                placeholder="https://host/v1  or  http://192.168.1.50:8000"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={t("bench.custom_base_url_daf8_2")}
              />
            </label>
            <label className="te-simple__field">
              <span className="eyebrow">{t("tokens.col_model")}</span>
              <input type="text" value={modelName} onChange={(e) => setValue("model", e.target.value)} placeholder="auto-detect" spellCheck={false} aria-label={t("bench.model_name_402d_2")} />
            </label>
            <label className="te-simple__field">
              <span className="eyebrow">{t("bench.api_key_656a")}</span>
              <input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => onApiKey(e.target.value)} placeholder="if required" aria-label={t("bench.api_key_656a_2")} />
            </label>
            <p className="te-simple__hint">The run happens on {spark.name}, so it must be able to reach this URL. The key is sent to {spark.name} for this run only and is not stored here.</p>
            {!baseUrl.trim() ? <p className="te-simple__warn">{t("bench.enter_the_url_of_the_16f7_2")}</p> : null}
          </div>
        ) : (
          <>
            <div className="te-simple__target-row">
              <b>{llm?.available && llm.modelId ? llm.modelId : "The model on this DGX Spark"}</b>
              <span className="mono">http://127.0.0.1:{port}</span>
              {ports.length > 1 ? (
                <label className="te-simple__port">
                  <span className="eyebrow">Port</span>
                  <select value={port} onChange={(e) => onChange({ ...state, port: Number(e.target.value) })} aria-label={t("bench.llm_port_to_test_72a0_2")}>
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
              <p className="te-simple__warn">{t("bench.no_model_is_answering_on_cf12_2")}</p>
            ) : null}
          </>
        )}
        </div>
      </div>

      <div className="te-simple__cards" role="radiogroup" aria-label={t("bench.ready_made_runs_30df_2")}>
        {templates.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active?.id === t.id}
            tabIndex={(active ? active.id === t.id : i === 0) ? 0 : -1}
            onKeyDown={(e) => onRovingKeyDown(e, "radio", (n) => pick(templates[n].id))}
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

      {type === "tool-eval" ? <TrialsRow state={state} onChange={onChange} /> : null}

      {custom ? (
        <p className="te-simple__custom">
          {t("bench.custom_applied")}{" "}
          <button type="button" className="te-link" onClick={onAdvanced}>
            {t("presets.review_in_advanced")}
          </button>{" "}
          or pick a template above to start fresh.
        </p>
      ) : (
        <p className="te-simple__more">
          {t("presets.need_control2")}{" "}
          <button type="button" className="te-link" onClick={onAdvanced}>
            {t("presets.open_advanced")}
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
