import { useMemo, useState, type ReactNode } from "react";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { fmtPct, formatAgo, sortRows, type EndpointRow, type ModelRow, type SortDir } from "./tokenStats";

const INITIAL_ROWS = 10;
const fmt = formatTokensCompact;

interface Col<T> {
  id: string;
  label: string;
  num?: boolean;
  /** Sort accessor; omit for a non-sortable column. */
  get?: (row: T) => number | string | null;
  /** Direction on first click. */
  first?: SortDir;
}

interface SortState {
  id: string;
  dir: SortDir;
}

function ariaSort(active: boolean, dir: SortDir): "ascending" | "descending" | "none" {
  return active ? (dir === "asc" ? "ascending" : "descending") : "none";
}

/** Sortable, truncating table shell shared by both tables: header buttons, aria-sort, "show all" toggle. */
function SortTable<T>({
  caption,
  cols,
  rows,
  initial,
  rowKey,
  cell,
  noun,
}: {
  caption: string;
  cols: readonly Col<T>[];
  rows: readonly T[];
  initial: SortState;
  rowKey: (row: T) => string;
  cell: (col: Col<T>, row: T) => ReactNode;
  noun: string;
}) {
  const [sort, setSort] = useState<SortState>(initial);
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    const col = cols.find((c) => c.id === sort.id);
    return col?.get ? sortRows(rows, col.get, sort.dir) : [...rows];
  }, [rows, cols, sort]);
  const shown = all ? sorted : sorted.slice(0, INITIAL_ROWS);

  const click = (col: Col<T>) =>
    setSort((s) => (s.id === col.id ? { id: col.id, dir: s.dir === "asc" ? "desc" : "asc" } : { id: col.id, dir: col.first ?? (col.num ? "desc" : "asc") }));

  return (
    <>
      <div className="tk-scroll" tabIndex={0} role="region" aria-label={`${caption} (scrollable)`}>
        <table className="tk-table">
          <caption className="tk-sr">{caption}</caption>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.id} scope="col" className={c.num ? "is-num" : undefined} aria-sort={c.get ? ariaSort(sort.id === c.id, sort.dir) : undefined}>
                  {c.get ? (
                    <button type="button" onClick={() => click(c)}>
                      {c.label}
                      <span aria-hidden="true" className="tk-sort">{sort.id === c.id ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={rowKey(r)}>
                {cols.map((c) => (
                  <td key={c.id} className={c.num ? "is-num mono" : undefined}>
                    {cell(c, r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > INITIAL_ROWS ? (
        <button type="button" className="btn btn--sm btn--ghost tk-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? `Show top ${INITIAL_ROWS}` : `Show all ${sorted.length} ${noun}`}
        </button>
      ) : null}
    </>
  );
}

function ShareBar({ share }: { share: number }) {
  return (
    <span className="tk-share" title={fmtPct(share)}>
      <span className="tk-share__bar" aria-hidden="true">
        <i style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
      </span>
      <span className="tk-share__pct mono">{fmtPct(share)}</span>
    </span>
  );
}

function CacheCell({ rate, cached }: { rate: number | null; cached: number }) {
  if (rate == null) return <span className="tk-faint" title="No prompt tokens reported">{"—"}</span>;
  return <span title={`${cached.toLocaleString()} cached prompt tokens`}>{fmtPct(rate)}</span>;
}

/** Chips for a list of names, folding the overflow into "+N". */
function NameList({ names, max = 3 }: { names: readonly string[]; max?: number }) {
  const extra = names.length - max;
  return (
    <span className="tk-names" title={names.join(", ")}>
      {names.slice(0, max).map((n) => (
        <span key={n} className="tk-chip">{n}</span>
      ))}
      {extra > 0 ? <span className="tk-chip tk-chip--more">+{extra}</span> : null}
    </span>
  );
}

export function ModelTable({ rows, sparkName, nowMs }: { rows: readonly ModelRow[]; sparkName: (id: string) => string; nowMs: number }) {
  const cols: Col<ModelRow>[] = [
    { id: "model", label: "Model", get: (r) => r.modelId },
    { id: "generated", label: "Generated", num: true, get: (r) => r.generated },
    { id: "prompt", label: "Prompt", num: true, get: (r) => r.prompt },
    { id: "cache", label: "Cached", num: true, get: (r) => r.cacheRate },
    { id: "total", label: "Total", num: true, get: (r) => r.total },
    { id: "share", label: "Share of total", get: (r) => r.share, first: "desc" },
    { id: "sparks", label: "Active on", get: (r) => r.sparkIds.length, first: "desc" },
    { id: "seen", label: "Last seen", get: (r) => r.lastSeen, first: "desc" },
  ];
  return (
    <SortTable
      caption="Token totals by model"
      noun="models"
      cols={cols}
      rows={rows}
      initial={{ id: "total", dir: "desc" }}
      rowKey={(r) => r.modelId}
      cell={(c, r) => {
        switch (c.id) {
          case "model":
            return <span className="tk-name" title={r.modelId}>{r.modelId}</span>;
          case "generated":
            return <span title={r.generated.toLocaleString()}>{fmt(r.generated)}</span>;
          case "prompt":
            return <span title={`${r.prompt.toLocaleString()} (${r.computed.toLocaleString()} computed)`}>{fmt(r.prompt)}</span>;
          case "cache":
            return <CacheCell rate={r.cacheRate} cached={r.cached} />;
          case "total":
            return <b title={r.total.toLocaleString()}>{fmt(r.total)}</b>;
          case "share":
            return <ShareBar share={r.share} />;
          case "sparks":
            return <NameList names={r.sparkIds.map(sparkName)} />;
          default:
            return r.lastSeen ? <span title={new Date(r.lastSeen).toLocaleString()}>{formatAgo(r.lastSeen, nowMs)}</span> : <span className="tk-faint">{"—"}</span>;
        }
      }}
    />
  );
}

export function EndpointTable({
  rows,
  sparkName,
  knownSpark,
  onSelectSpark,
}: {
  rows: readonly EndpointRow[];
  sparkName: (id: string) => string;
  /** True when the id belongs to a Spark that still exists (so it can be opened). */
  knownSpark: (id: string) => boolean;
  onSelectSpark?: (id: string) => void;
}) {
  const cols: Col<EndpointRow>[] = [
    { id: "spark", label: "Spark", get: (r) => sparkName(r.sparkId) },
    { id: "port", label: "Port", num: true, get: (r) => r.port, first: "asc" },
    { id: "models", label: "Models served", get: (r) => r.models.length, first: "desc" },
    { id: "generated", label: "Generated", num: true, get: (r) => r.generated },
    { id: "prompt", label: "Prompt", num: true, get: (r) => r.prompt },
    { id: "cache", label: "Cached", num: true, get: (r) => r.cacheRate },
    { id: "total", label: "Total", num: true, get: (r) => r.total },
    { id: "share", label: "Share of total", get: (r) => r.share, first: "desc" },
  ];
  return (
    <SortTable
      caption="Token totals by Spark and endpoint"
      noun="endpoints"
      cols={cols}
      rows={rows}
      initial={{ id: "total", dir: "desc" }}
      rowKey={(r) => `${r.sparkId}:${r.port}`}
      cell={(c, r) => {
        switch (c.id) {
          case "spark":
            return onSelectSpark && knownSpark(r.sparkId) ? (
              <button type="button" className="tk-link" onClick={() => onSelectSpark(r.sparkId)} title={`Open ${sparkName(r.sparkId)}`}>
                {sparkName(r.sparkId)}
              </button>
            ) : (
              <span className="tk-name">{sparkName(r.sparkId)}</span>
            );
          case "port":
            return r.port;
          case "models":
            return <NameList names={r.models} max={2} />;
          case "generated":
            return <span title={r.generated.toLocaleString()}>{fmt(r.generated)}</span>;
          case "prompt":
            return <span title={`${r.prompt.toLocaleString()} (${r.computed.toLocaleString()} computed)`}>{fmt(r.prompt)}</span>;
          case "cache":
            return <CacheCell rate={r.cacheRate} cached={r.cached} />;
          case "total":
            return <b title={r.total.toLocaleString()}>{fmt(r.total)}</b>;
          default:
            return <ShareBar share={r.share} />;
        }
      }}
    />
  );
}
