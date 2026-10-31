import { useToolEvalSpecLabels, useToolEvalPresetLabels } from "./labels";
import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import type { SparkSnapshot, ToolEvalArgSpec, ToolEvalSpec } from "../../../api/types";
import { Field } from "./Fields";
import { keptValues } from "./presets";
import { TrialsRow } from "./TrialsRow";
import { SUITES, advancedFields, countSet, groupFields, presetsFor, typeConfig, applyPreset, emptyState, type FieldValue, type FormState } from "./options";

interface ConfigFormProps {
  spec: ToolEvalSpec;
  type: string;
  spark: SparkSnapshot;
  state: FormState;
  onChange: (next: FormState) => void;
  apiKey: string;
  onApiKey: (v: string) => void;
  fieldErrors: Record<string, string>;
  formErrors: string[];
  disabled?: boolean;
}

const isSet = (v: FieldValue | undefined) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.every((x) => !x.trim()));

/** The form generated from the option spec: page-relevant groups, presets, and an "all options" disclosure. */
export function ConfigForm({ spec: rawSpec, type, spark, state, onChange, apiKey, onApiKey, fieldErrors, formErrors, disabled }: ConfigFormProps) {
  const { t } = useTranslation("tooleval");
  const spec = useToolEvalSpecLabels(rawSpec) ?? rawSpec;
  const presetLabels = useToolEvalPresetLabels();
  const suiteHelp = { gsm8k: t("metadata.suite.math"), mmlu: t("metadata.suite.knowledge"), ifeval: t("metadata.suite.instructions") };
  const cfg = typeConfig(type);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const presets = presetsFor(type).map((preset) => ({ ...preset, ...presetLabels.presets[type]?.[preset.id] }));
  const setValue = (name: string, v: FieldValue) => {
    setActivePreset(null);
    onChange({ ...state, values: { ...state.values, [name]: v } });
  };
  const groups = useMemo(
    () => cfg.groups.map((sel) => ({ sel, group: spec.groups.find((g) => g.id === sel.id), fields: groupFields(spec, type, sel) })).filter((g) => g.group),
    [cfg, spec, type]
  );
  const advanced = useMemo(() => advancedFields(spec, type), [spec, type]);
  const advancedByGroup = useMemo(() => {
    const out: { id: string; label: string; fields: ToolEvalArgSpec[] }[] = [];
    for (const f of advanced) {
      let g = out.find((x) => x.id === f.group);
      if (!g) out.push((g = { id: f.group, label: spec.groups.find((x) => x.id === f.group)?.label ?? f.group, fields: [] }));
      g.fields.push(f);
    }
    return out;
  }, [advanced, spec.groups]);
  const advancedSet = advanced.filter((f) => isSet(state.values[f.name])).length;
  const ports = spark.llmPorts && spark.llmPorts.length ? spark.llmPorts : spark.llmPort ? [spark.llmPort] : [];
  const portIndex = Math.max(0, ports.indexOf(state.port ?? ports[0]));
  const liveModel = spark.metrics?.llm?.[portIndex]?.modelId ?? spark.metrics?.llm?.find((l) => l.available)?.modelId ?? null;
  const hasSavedKey = (spark.llmApiKeyPorts ?? []).includes(state.port ?? ports[0]);

  return (
    <div className="te-form">
      <div className="te-form__bar">
        <div className="te-presets" role="group" aria-label={t("ui.form.presets")}>
          <span className="eyebrow">{t("ui.form.presets")}</span>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`te-chip te-chip--text ${activePreset === p.id ? "is-on" : ""}`}
              aria-pressed={activePreset === p.id}
              title={p.help}
              disabled={disabled}
              onClick={() => {
                setActivePreset(p.id);
                const next = applyPreset(type, p);
                onChange({ ...next, values: { ...next.values, ...keptValues(state.values) }, port: state.port, extraArgs: state.extraArgs });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="te-form__tools">
          <span className="te-faint">{t("form.optionsSet", { count: countSet(state) })}</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={disabled}
            onClick={() => {
              setActivePreset(null);
              onChange({ ...emptyState(type), port: state.port });
              onApiKey("");
            }}
          >
            {t("ui.form.reset")}
          </button>
        </div>
      </div>
      {activePreset ? <p className="te-preset-help">{presets.find((p) => p.id === activePreset)?.help}</p> : null}
      {type === "tool-eval" ? <TrialsRow state={state} onChange={onChange} disabled={disabled} /> : null}

      {formErrors.length ? (
        <ul className="te-form-errors" role="alert">
          {formErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      {type === "accuracy" ? (
        <fieldset className="te-suites">
          <legend className="field-label">{t("ui.form.suites")}</legend>
          <div className="te-suites__row">
            {SUITES.map((s) => {
              const on = state.suites.includes(s.id);
              return (
                <label key={s.id} className={`te-suite ${on ? "is-on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={() => onChange({ ...state, suites: SUITES.map((x) => x.id as string).filter((id) => (id === s.id ? !on : state.suites.includes(id))) })}
                  />
                  <span>
                    <b>{s.label}</b>
                    <small>{suiteHelp[s.id]}</small>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="field-hint">{t("ui.form.suitesHint")}</p>
        </fieldset>
      ) : null}

      {groups.map(({ sel, group, fields }, gi) => {
        const nSet = fields.filter((f) => isSet(state.values[f.name])).length;
        const isConn = sel.id === "connection";
        const off = type === "accuracy" && SUITES.some((s) => s.id === sel.id && !state.suites.includes(s.id));
        return (
          <details key={sel.id} className={`te-group ${off ? "is-off" : ""}`} open={gi < 2 || nSet > 0}>
            <summary>
              <span className="te-group__title">{sel.label ?? group!.label}</span>
              <span className="te-group__meta">{off ? t("ui.form.suiteNotSelected") : nSet ? t("form.set", { count: nSet }) : ""}</span>
            </summary>
            <p className="te-group__help">{group!.help}</p>
            <div className="te-grid">
              {isConn && ports.length > 1 ? (
                <div className="te-field">
                  <label className="field-label" htmlFor="te-f-port">
                    {t("form.port", { name: spark.name })}
                  </label>
                  <select id="te-f-port" value={state.port ?? ports[0]} onChange={(e) => onChange({ ...state, port: Number(e.target.value) })} disabled={disabled}>
                    {ports.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">{t("ui.form.portHint")}</p>
                </div>
              ) : null}
              {fields.map((f) => (
                <Field key={f.name} arg={f} value={state.values[f.name]} error={fieldErrors[f.name]} onChange={setValue} />
              ))}
              {isConn ? (
                <>
                  {liveModel ? (
                    <p className="te-hint-line te-field--wide">
                      {t("form.servedModel", { model: liveModel })}
                    </p>
                  ) : null}
                  <div className="te-field te-field--wide">
                    <label className="field-label" htmlFor="te-f-api-key">
                      {t("ui.simple.apiKey")}
                    </label>
                    <input id="te-f-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => onApiKey(e.target.value)} placeholder={hasSavedKey ? t("ui.form.usingSavedKey") : t("ui.form.leaveSavedKey")} disabled={disabled} />
                    <p className="field-hint">
                      {t("form.keyHelp", { saved: hasSavedKey ? t("form.keySaved") : "" })}
                    </p>
                  </div>
                </>
              ) : null}
            </div>
          </details>
        );
      })}

      <details className="te-group te-group--adv" open={advancedSet > 0 || undefined}>
        <summary>
          <span className="te-group__title">{t("ui.form.advanced")}</span>
          <span className="te-group__meta">{t("form.moreOptions", { count: advanced.length, set: advancedSet ? ` · ${t("form.optionsSet", { count: advancedSet })}` : "" })}</span>
        </summary>
        <p className="te-group__help">{t("ui.form.advancedHint")}</p>
        {advancedByGroup.map((g) => (
          <fieldset key={g.id} className="te-subgroup">
            <legend>{g.label}</legend>
            <div className="te-grid">
              {g.fields.map((f) => (
                <Field key={f.name} arg={f} value={state.values[f.name]} error={fieldErrors[f.name]} onChange={setValue} />
              ))}
            </div>
          </fieldset>
        ))}
      </details>

      <div className="te-field te-field--wide te-extra">
        <label className="field-label" htmlFor="te-f-extra">
          {t("ui.form.additionalArgs")}
        </label>
        <input id="te-f-extra" type="text" className="te-mono-input" value={state.extraArgs} onChange={(e) => onChange({ ...state, extraArgs: e.target.value })} placeholder="--some-new-flag value" autoComplete="off" spellCheck={false} disabled={disabled} />
        <p className="field-hint">{t("ui.form.additionalArgsHint")}</p>
      </div>
    </div>
  );
}
