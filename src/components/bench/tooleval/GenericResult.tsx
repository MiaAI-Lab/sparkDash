import { LineAreaChart } from "../../ui/LineAreaChart";
import { Tag } from "../../ui/Tag";
import { cellText, collectTables, isNum, isObj, suggestCharts, topMetrics, type GenericTable } from "./normalize";
import { fmtNum, humanizeKey } from "./format";
import { JsonDisclosure } from "./parts";

/** Recursively render any JSON value: scalars as text, objects as key/value lists, arrays of objects as tables or cards. */
export function GenericValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) return <span className="te-faint">–</span>;
  if (typeof value === "boolean") return <Tag tone={value ? "good" : "neutral"}>{value ? "yes" : "no"}</Tag>;
  if (isNum(value)) return <span className="mono">{fmtNum(value, 3)}</span>;
  if (typeof value === "string") {
    return value.length > 120 || value.includes("\n") ? <pre className="te-pre">{value}</pre> : <span>{value}</span>;
  }
  if (depth > 5) return <code>{JSON.stringify(value).slice(0, 200)}</code>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="te-faint">empty</span>;
    if (value.every((v) => v == null || typeof v !== "object")) {
      return (
        <span className="te-valuelist">
          {value.map((v, i) => (
            <span key={i} className="te-token">
              {String(v)}
            </span>
          ))}
        </span>
      );
    }
    if (value.every(isObj)) {
      const rows = value as Record<string, unknown>[];
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => !Array.isArray(r[k]) && !isObj(r[k]) || (isObj(r[k]) && Object.keys(r[k] as object).length <= 4))))];
      const long = rows.some((r) => cols.some((c) => typeof r[c] === "string" && (r[c] as string).length > 90));
      if (cols.length && cols.length <= 9 && !long && rows.every((r) => Object.values(r).every((v) => !Array.isArray(v) && (!isObj(v) || Object.keys(v).length <= 4)))) {
        return <MiniTable columns={cols} rows={rows} />;
      }
    }
    return (
      <div className="te-cards">
        {value.slice(0, 100).map((v, i) => (
          <div key={i} className="te-card-item">
            <GenericValue value={v} depth={depth + 1} />
          </div>
        ))}
        {value.length > 100 ? <span className="te-faint">… {value.length - 100} more</span> : null}
      </div>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="te-faint">empty</span>;
  return (
    <dl className="te-kv">
      {entries.map(([k, v]) => (
        <div key={k} className={typeof v === "object" && v !== null ? "is-block" : undefined}>
          <dt>{humanizeKey(k)}</dt>
          <dd>
            <GenericValue value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function MiniTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  return (
    <div className="te-tablewrap">
      <table className="te-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className={rows.some((r) => isNum(r[c])) ? "is-num" : undefined}>
                {humanizeKey(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 300).map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c} className={isNum(r[c]) ? "is-num" : undefined}>
                  {isNum(r[c]) ? fmtNum(r[c], 3) : cellText(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 300 ? <p className="te-faint">Showing 300 of {rows.length} rows.</p> : null}
    </div>
  );
}

function TableWithCharts({ table }: { table: GenericTable }) {
  const charts = suggestCharts(table);
  return (
    <section className="te-section">
      <h3>{table.title}</h3>
      {charts.length ? (
        <div className="te-charts">
          {charts.map((c) => (
            <figure key={`${c.yKey}-${c.group}`} className="te-chart">
              <figcaption>{c.title}</figcaption>
              <LineAreaChart
                height={170}
                ariaLabel={c.title}
                format={(v) => fmtNum(v, 2)}
                points={c.points.map((p) => ({ key: String(p.x), label: p.label, title: `${humanizeKey(c.xKey)} ${p.label}`, value: p.value }))}
              />
            </figure>
          ))}
        </div>
      ) : null}
      <MiniTable columns={table.columns} rows={table.rows} />
    </section>
  );
}

/** Metric-first view for results whose structure is not known in advance. */
export function GenericResult({ result, compact = false }: { result: unknown; compact?: boolean }) {
  const tiles = topMetrics(result);
  const tables = collectTables(result);
  const meta = isObj(result) ? (isObj(result.config) ? result.config : null) : null;
  return (
    <div className="te-generic">
      {tiles.length && !compact ? (
        <div className="te-tiles" role="list" aria-label="Key numbers">
          {tiles.map((t) => (
            <div key={t.path} className="te-tile" role="listitem" title={t.path}>
              <span className="eyebrow">{t.label}</span>
              <b className="big-num">{typeof t.value === "number" ? fmtNum(t.value, 3) : String(t.value)}</b>
            </div>
          ))}
        </div>
      ) : null}
      {tables.map((t) => (
        <TableWithCharts key={t.path} table={t} />
      ))}
      {!compact && !tiles.length && !tables.length ? <p className="te-faint">No recognisable numbers in this result. The full data is below.</p> : null}
      {meta && !compact ? (
        <details className="te-disclosure">
          <summary>
            <span>Configuration reported by the tool</span>
          </summary>
          <div className="te-disclosure__body">
            <GenericValue value={meta} />
          </div>
        </details>
      ) : null}
      {!compact ? (
        <>
          <details className="te-disclosure">
            <summary>
              <span>All values</span>
            </summary>
            <div className="te-disclosure__body">
              <GenericValue value={result} />
            </div>
          </details>
          <JsonDisclosure value={result} />
        </>
      ) : null}
    </div>
  );
}
