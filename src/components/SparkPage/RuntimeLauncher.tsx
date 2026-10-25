import { useEffect, useMemo, useState } from "react";
import type { MacRuntime, RuntimeControlTarget, RuntimeControlView } from "../../api/types";
import { fetchRuntimeControl, startMacRuntime, stopMacRuntime } from "../../api/client";
import { Panel } from "../ui/Panel";

/**
 * Mac node launcher. The button is absent unless control is actually ready,
 * and it is never styled as success: green is reserved for a probe that says
 * something is serving. Mounting this tile does not start a runtime.
 */

const fieldClass =
  "w-full rounded border border-border bg-surface-elevated px-2 py-1 text-[12px] text-text outline-none focus:border-accent";

type Load = (sparkId: string) => Promise<RuntimeControlView>;
type Act = (sparkId: string, runtime: string, model?: string) => Promise<RuntimeControlView>;

function servingText(serving: MacRuntime[] | null | undefined): string {
  if (!Array.isArray(serving)) return "Serving status unavailable";
  if (serving.length === 0) return "Nothing serving";
  return serving
    .map((runtime) => {
      const name = runtime.model || runtime.label || runtime.name;
      const where = runtime.port ? `:${runtime.port}` : runtime.state;
      return `${name} (${where})`;
    })
    .join("; ");
}

function groupsOf(targets: RuntimeControlTarget[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const target of targets) {
    if (!seen.has(target.group)) seen.set(target.group, target.groupLabel || target.group);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

export function RuntimeLauncher({
  sparkId,
  metricsRuntimes,
  agentOnline,
  load = fetchRuntimeControl,
  start = startMacRuntime,
  stop = stopMacRuntime,
}: {
  sparkId: string;
  metricsRuntimes?: MacRuntime[] | null;
  agentOnline?: boolean | null;
  load?: Load;
  start?: Act;
  stop?: (sparkId: string, runtime: string) => Promise<RuntimeControlView>;
}) {
  const [status, setStatus] = useState<RuntimeControlView | null>(null);
  const [freshProbe, setFreshProbe] = useState<MacRuntime[] | null | undefined>(undefined);
  const [group, setGroup] = useState<string>("");
  const [targetName, setTargetName] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [picked, setPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    load(sparkId).then((next) => {
      if (!cancelled) setStatus(next);
    }).catch((err: unknown) => {
      if (cancelled) return;
      const reason = err instanceof Error ? err.message : "runtime control request failed";
      setStatus({ state: "unavailable", reason, serving: null, targets: [], error: reason });
    });
    return () => {
      cancelled = true;
    };
  }, [sparkId, load]);

  useEffect(() => {
    setFreshProbe(undefined);
  }, [metricsRuntimes, agentOnline]);

  const targets = status?.targets ?? [];
  const groups = useMemo(() => groupsOf(targets), [targets]);
  const groupTargets = targets.filter((target) => target.group === (group || groups[0]?.id));
  const selected = groupTargets.find((target) => target.name === targetName) ?? groupTargets[0] ?? null;
  const models = selected?.models ?? [];
  const selectedModel = models.find((model) => model.id === modelId) ?? models[0] ?? null;

  useEffect(() => {
    if (picked || targets.length === 0) return;
    const servingNames = new Set((status?.serving ?? []).map((runtime) => runtime.name));
    const match = targets.find((target) => servingNames.has(target.name)) ?? targets[0];
    setGroup(match.group);
    setTargetName(match.name);
    setModelId(match.models[0]?.id ?? "");
  }, [picked, targets, status]);

  const serving = freshProbe !== undefined
    ? freshProbe
    : agentOnline === false
      ? null
      : Array.isArray(metricsRuntimes)
        ? metricsRuntimes
        : status?.serving ?? null;
  const servingNow = Array.isArray(serving) && selected
    ? serving.some((runtime) => runtime.name === selected.name)
    : false;
  const ready = status?.state === "ready" && !busy;
  const canLaunch = Boolean(selected?.startable && Array.isArray(serving) && !servingNow);
  const canStop = Boolean(selected?.stoppable && servingNow);
  const showAction = status?.state === "ready" && (canLaunch || canStop || busy);

  async function onAction() {
    if (!selected || busy) return;
    const stopping = servingNow;
    if (stopping ? !selected.stoppable : !selected.startable) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = stopping
        ? await stop(sparkId, selected.name)
        : await start(sparkId, selected.name, selectedModel?.id);
      setStatus(result);
      setFreshProbe(result.serving);
      if (result.state === "denied" || result.state === "unavailable") {
        setActionError(result.reason || result.error || "Runtime control refused the action");
      } else if (result.ok === false || result.error) {
        setActionError(result.error || result.reason || "Runtime control action failed");
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Runtime control action failed";
      setActionError(reason);
    } finally {
      setBusy(false);
    }
  }

  const headline = status == null
    ? "Checking runtime control…"
    : status.state === "denied"
      ? `Permission denied — ${status.reason || "the agent refused runtime control"}`
      : status.state === "unavailable"
        ? `Unavailable — ${status.reason || "runtime control is not available"}`
        : null;

  return (
    <Panel title="Runtime launcher" className="panel-runtime-launcher">
      <div className="flex flex-col gap-2" data-testid="runtime-launcher">
        <p
          className={`text-[12px] ${status?.state === "denied" ? "text-danger" : status?.state === "unavailable" || serving === null ? "text-warning" : "text-text"}`}
          data-testid="runtime-launcher-serving"
        >
          {headline ?? servingText(serving)}
        </p>
        {status?.state === "ready" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-[11px] text-muted">
              Runtime
              <select
                className={`${fieldClass} mt-1`}
                value={selected?.group ?? ""}
                onChange={(event) => {
                  const nextGroup = event.target.value;
                  const next = targets.find((target) => target.group === nextGroup);
                  setPicked(true);
                  setGroup(nextGroup);
                  setTargetName(next?.name ?? "");
                  setModelId(next?.models[0]?.id ?? "");
                }}
              >
                {groups.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] text-muted">
              Model
              <select
                className={`${fieldClass} mt-1`}
                value={selected?.name ?? ""}
                onChange={(event) => {
                  const next = targets.find((target) => target.name === event.target.value);
                  setPicked(true);
                  setTargetName(next?.name ?? "");
                  setModelId(next?.models[0]?.id ?? "");
                }}
              >
                {groupTargets.map((target) => (
                  <option key={target.name} value={target.name}>
                    {target.models[0]?.label || target.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {showAction && (
          <button
            type="button"
            data-action={servingNow ? "stop" : "launch"}
            disabled={!ready || !(canLaunch || canStop)}
            onClick={() => void onAction()}
            className={`self-start rounded-md border bg-surface-elevated px-3 py-1.5 text-[11px] disabled:opacity-50 ${
              servingNow
                ? "border-danger/40 text-danger hover:bg-danger/10"
                : "border-border text-text hover:bg-surface-hover"
            }`}
          >
            {busy ? "Working…" : servingNow ? "Stop" : "Launch"}
          </button>
        )}
        {status?.state === "ready" && !showAction && !busy && (
          <p className="text-[11px] text-muted">
            {serving === null
              ? "Not launching blind — serving status is unavailable."
              : selected?.reason || "No launch command is configured for this runtime."}
          </p>
        )}
        {actionError && (
          <p className="whitespace-pre-wrap text-[12px] text-danger" data-testid="runtime-launcher-error">
            {actionError}
          </p>
        )}
      </div>
    </Panel>
  );
}
