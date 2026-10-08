import { useState } from "react";
import type { ToolEvalArgSpec } from "../../../api/types";
import { byteLength, jsonObjectError, splitList, type FieldValue } from "./options";
import { fmtBytes } from "./format";
import { CATEGORY_NAMES } from "./normalize";

interface FieldProps {
  arg: ToolEvalArgSpec;
  value: FieldValue | undefined;
  error?: string | null;
  onChange: (name: string, v: FieldValue) => void;
}

const idOf = (name: string) => `te-f-${name}`;

function rangeHint(a: ToolEvalArgSpec): string {
  const parts: string[] = [];
  if (a.min != null && a.max != null) parts.push(`${a.min}–${a.max}`);
  else if (a.min != null) parts.push(`min ${a.min}`);
  else if (a.max != null) parts.push(`max ${a.max}`);
  if (a.default !== undefined && a.default !== "") parts.push(`default ${a.default}`);
  return parts.join(" · ");
}

/** One generated form control, chosen by the option's kind. */
export function Field({ arg, value, error, onChange }: FieldProps) {
  const id = idOf(arg.name);
  const set = (v: FieldValue) => onChange(arg.name, v);
  const err = error ? (
    <p className="field-hint is-warn" id={`${id}-err`} role="alert">
      {error}
    </p>
  ) : null;
  const describedBy = error ? `${id}-err` : `${id}-help`;
  const help = (
    <p className="field-hint" id={`${id}-help`}>
      {arg.help}
    </p>
  );

  if (arg.kind === "bool") {
    return (
      <div className={`te-field te-field--bool ${error ? "has-error" : ""}`}>
        <label className="te-switch" htmlFor={id}>
          <input id={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => set(e.target.checked)} aria-describedby={describedBy} />
          <span className="te-switch__track" aria-hidden />
          <span className="te-switch__text">
            <b>{arg.label}</b>
            <small>{arg.help}</small>
          </span>
        </label>
        {err}
      </div>
    );
  }

  let control;
  switch (arg.kind) {
    case "int":
    case "float":
      control = (
        <input
          id={id}
          type="number"
          inputMode={arg.kind === "int" ? "numeric" : "decimal"}
          step={arg.kind === "int" ? 1 : "any"}
          min={arg.min}
          max={arg.max}
          value={typeof value === "string" ? value : ""}
          placeholder={arg.default !== undefined ? String(arg.default) : ""}
          onChange={(e) => set(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
        />
      );
      break;
    case "choice":
      control = (
        <select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value)} aria-describedby={describedBy}>
          <option value="">{arg.default !== undefined ? `Default (${arg.default})` : "Default"}</option>
          {(arg.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
      break;
    case "text": {
      const text = typeof value === "string" ? value : "";
      const bytes = byteLength(text);
      const max = arg.maxBytes ?? 32768;
      control = (
        <>
          <textarea id={id} rows={4} value={text} onChange={(e) => set(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={describedBy} spellCheck={false} />
          <p className={`te-counter ${bytes > max ? "is-over" : ""}`} aria-live="polite">
            {fmtBytes(bytes)} of {fmtBytes(max)}
          </p>
        </>
      );
      break;
    }
    case "json": {
      const text = typeof value === "string" ? value : "";
      const bad = text.trim() ? jsonObjectError(text) : null;
      control = (
        <>
          <textarea id={id} rows={3} className="te-mono-input" value={text} placeholder='{"chat_template_kwargs": {"enable_thinking": false}}' onChange={(e) => set(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={describedBy} spellCheck={false} />
          {text.trim() ? <p className={`te-counter ${bad ? "is-over" : "is-ok"}`}>{bad ? `JSON ${bad}` : "Valid JSON object"}</p> : null}
        </>
      );
      break;
    }
    case "list":
      control = arg.choices ? (
        <CategoryPicker id={id} value={Array.isArray(value) ? value : []} choices={arg.choices} onChange={set} />
      ) : (
        <>
          <input id={id} type="text" value={typeof value === "string" ? value : ""} placeholder={arg.name === "scenarios" ? "TC-01 TC-07 TC-12" : "space separated"} onChange={(e) => set(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={describedBy} autoComplete="off" spellCheck={false} />
          {typeof value === "string" && value.trim() ? <p className="te-counter">{splitList(value).length} item(s)</p> : null}
        </>
      );
      break;
    case "repeat":
      control = <RepeatRows id={id} arg={arg} rows={Array.isArray(value) ? value : []} onChange={set} />;
      break;
    default:
      control = (
        <input
          id={id}
          type="text"
          className={arg.kind === "url" || arg.kind === "path" || arg.kind === "csv" || arg.kind === "range" ? "te-mono-input" : undefined}
          value={typeof value === "string" ? value : ""}
          placeholder={arg.default !== undefined ? String(arg.default) : arg.kind === "url" ? "http://127.0.0.1:8888" : arg.kind === "path" ? "/home/user/…" : arg.kind === "range" ? "0.5-1.0" : ""}
          onChange={(e) => set(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
        />
      );
  }
  const hint = rangeHint(arg);
  return (
    <div className={`te-field ${error ? "has-error" : ""} ${arg.kind === "text" || arg.kind === "json" || arg.kind === "repeat" || arg.kind === "list" ? "te-field--wide" : ""}`}>
      <label className="field-label" htmlFor={arg.kind === "list" && arg.choices ? undefined : id}>
        {arg.label}
        {hint ? <span className="te-faint"> · {hint}</span> : null}
      </label>
      {control}
      {err ?? help}
    </div>
  );
}

function CategoryPicker({ id, value, choices, onChange }: { id: string; value: string[]; choices: string[]; onChange: (v: string[]) => void }) {
  const on = new Set(value.map((v) => v.toUpperCase()));
  const toggle = (c: string) => onChange(choices.filter((x) => (x === c ? !on.has(x) : on.has(x))));
  return (
    <div className="te-cats" role="group" aria-label="Categories" id={id}>
      {choices.map((c) => (
        <button key={c} type="button" className={`te-chip ${on.has(c) ? "is-on" : ""}`} aria-pressed={on.has(c)} onClick={() => toggle(c)} title={CATEGORY_NAMES[c] ? `${c}: ${CATEGORY_NAMES[c]}` : c}>
          <b>{c}</b>
          <span>{CATEGORY_NAMES[c] ?? ""}</span>
        </button>
      ))}
      <span className="te-cats__tools">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange([...choices])}>
          All
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange([])} disabled={on.size === 0}>
          None
        </button>
      </span>
    </div>
  );
}

function RepeatRows({ id, arg, rows, onChange }: { id: string; arg: ToolEvalArgSpec; rows: string[]; onChange: (v: string[]) => void }) {
  const [reveal, setReveal] = useState(false);
  const list = rows.length ? rows : [""];
  const max = arg.maxItems ?? 20;
  const placeholder = arg.name === "header" ? "X-Request-Source=sparkdash" : "/home/user/packs/my-pack";
  return (
    <div className="te-rows" id={id}>
      {list.map((row, i) => (
        <div key={i} className="te-rows__row">
          <input
            type={arg.secret && !reveal ? "password" : "text"}
            className="te-mono-input"
            value={row}
            placeholder={placeholder}
            aria-label={`${arg.label} ${i + 1}`}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange(list.map((r, j) => (j === i ? e.target.value : r)))}
          />
          <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${arg.label} ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))} disabled={list.length === 1 && !row}>
            Remove
          </button>
        </div>
      ))}
      <div className="te-rows__tools">
        <button type="button" className="btn btn--sm" onClick={() => onChange([...list, ""])} disabled={list.length >= max}>
          Add row
        </button>
        {arg.secret ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide values" : "Show values"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
