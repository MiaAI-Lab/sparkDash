import type { MacRuntime, MetricGap } from "../../api/types";
import { Panel } from "./Panel";

/**
 * What is actually serving on this machine, straight from the node agent's
 * data-driven inventory. Names come from the node's inventory file: a runtime
 * nobody catalogued shows up as `other-runtime` with its command basename
 * rather than being folded into a known engine it merely resembles.
 */

const STATE_DOT: Record<string, string> = {
  serving: "bg-success dot-glow-success",
  listening: "bg-warning",
  running: "bg-border",
};

function stateDot(runtime: MacRuntime): string {
  return STATE_DOT[runtime.state] ?? "bg-border";
}

function chipTitle(runtime: MacRuntime): string {
  const parts = [`${runtime.state} · pid ${runtime.pid}`];
  if (runtime.port) parts.push(`port ${runtime.port}`);
  if (runtime.model) parts.push(`model ${runtime.model}`);
  if (runtime.detectedBy === "listener") {
    parts.push("not in the runtime inventory — reported by its listener");
  }
  return parts.join(" · ");
}

export function RuntimeChips({ runtimes }: { runtimes: MacRuntime[] }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="runtime-chips">
      {runtimes.map((runtime) => {
        const other = runtime.name === "other-runtime";
        return (
          <span
            key={`${runtime.name}-${runtime.pid}-${runtime.port ?? "none"}`}
            title={chipTitle(runtime)}
            className={`inline-flex max-w-full items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] ${
              other ? "border-border/70 text-muted" : "border-border text-text"
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDot(runtime)}`} />
            <span className="truncate font-medium">
              {other ? runtime.label : runtime.name}
            </span>
            {runtime.port ? (
              <span className="font-tabular text-[10px] text-muted">:{runtime.port}</span>
            ) : null}
            {runtime.model ? (
              <span className="max-w-[12ch] truncate text-[10px] text-muted">{runtime.model}</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Mac Spark page: the runtime inventory panel. Rendered only when the node
 * reports runtimes at all (agent transport) — an SSH-read Mac has no inventory
 * to show, and "no data" must not look like "nothing serving".
 */
export function RuntimesPanel({
  runtimes,
  unavailable,
  agentOnline,
  className = "",
}: {
  runtimes: MacRuntime[];
  unavailable?: MetricGap[] | null;
  agentOnline?: boolean | null;
  className?: string;
}) {
  const agentGap = (unavailable ?? []).find((row) => row.metric === "agent");
  return (
    <Panel title="Model runtimes" className={`panel-runtimes ${className}`}>
      {agentOnline === false ? (
        <p className="text-[12px] text-warning" title={agentGap?.reason}>
          Agent unreachable — runtime inventory unknown
        </p>
      ) : runtimes.length === 0 ? (
        <p className="text-[12px] text-muted">
          Nothing serving — no runtime owns a listening port
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <RuntimeChips runtimes={runtimes} />
          <ul className="flex flex-col gap-1">
            {runtimes.map((runtime) => (
              <li
                key={`row-${runtime.name}-${runtime.pid}`}
                className="flex items-baseline justify-between gap-3 text-[12px]"
              >
                <span className="min-w-0 truncate text-text">
                  {runtime.model || runtime.label}
                </span>
                <span className="shrink-0 font-tabular text-[11px] text-muted">
                  {runtime.port ? `:${runtime.port}` : "no port"} · {runtime.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
