import { useEffect, useMemo, useRef, useState } from "react";
import type { MacRuntime, RuntimeControlTarget, RuntimeControlView } from "../../api/types";
import { fetchRuntimeControl, startMacRuntime, stopMacRuntime } from "../../api/client";
import { Panel } from "../ui/Panel";
import { ModelOutput } from "../ui/ModelOutput";
import { BotIcon } from "../ui/icons";

/**
 * Mac node launcher. The button is absent unless control is actually ready,
 * and it is never styled as success: green is reserved for a probe that says
 * something is serving. Mounting this tile does not start a runtime.
 */

const fieldClass =
  "w-full rounded border border-border bg-surface-elevated px-2 py-1 text-[12px] text-text outline-none focus:border-accent";

const NORMAL_POLL_MS = 5000;
const BUSY_POLL_MS = 2000;
const SERVING_NOTICE = "The selected profile is serving.";
const START_UNCONFIRMED_PREFIX = "Start command completed, but";
const LOST_RESPONSE_PREFIX = "No response from the agent:";

type RuntimeOperation = NonNullable<RuntimeControlView["operation"]>;

type ControlAction = "start" | "stop";
type ActionAttempt = {
  action: ControlAction;
  model?: string;
  target: RuntimeControlTarget;
  baselineOperationId?: string;
  transportFailed: boolean;
};

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

function normalizeModelPath(value: string | null | undefined): string | null {
  const model = value?.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return model || null;
}

function modelMatches(observed: string | null | undefined, expected: string | null | undefined): boolean {
  const actual = normalizeModelPath(observed);
  const wanted = normalizeModelPath(expected);
  if (!actual || !wanted) return false;
  return actual === wanted || actual.endsWith(`/${wanted}`) || actual.includes(`/${wanted}/`);
}

function isMux(runtime: MacRuntime): boolean {
  return /(?:^|[-_/])mux(?:$|[-_/])/i.test(runtime.name)
    || /(?:^|[-_/])mux(?:$|[-_/])/i.test(runtime.script || "");
}

function isActiveModelRuntime(runtime: MacRuntime): boolean {
  return runtime.role === "server"
    && (runtime.state === "serving" || runtime.state === "listening")
    && !isMux(runtime);
}

function runtimeInGroup(
  runtime: MacRuntime,
  group: string,
  targets: RuntimeControlTarget[],
): boolean {
  return runtimeNameInGroup(runtime.name, group, targets);
}

function runtimeNameInGroup(
  runtimeName: string,
  group: string,
  targets: RuntimeControlTarget[],
): boolean {
  const configuredRuntime = targets.find((target) => target.name === runtimeName);
  if (configuredRuntime) return configuredRuntime.group === group;
  return runtimeName === group || runtimeName.startsWith(`${group}-`);
}

function operationAction(action: string | undefined): ControlAction | null {
  const normalized = action?.toLowerCase();
  if (normalized === "start" || normalized === "launch") return "start";
  if (normalized === "stop") return "stop";
  return null;
}

function operationMatchesAttempt(
  operation: RuntimeOperation,
  attempt: ActionAttempt,
  targets: RuntimeControlTarget[],
): boolean {
  if (operation.id === attempt.baselineOperationId) return false;
  // Operation identity fields are optional; a new id resolves the single pending local action.
  const action = operationAction(operation.action);
  if (action && action !== attempt.action) return false;
  if (operation.runtime && !runtimeNameInGroup(operation.runtime, attempt.target.group, targets)) return false;
  if (operation.model && attempt.model && !modelMatches(operation.model, attempt.model)) return false;
  if (operation.model && !attempt.model && !attempt.target.models.some((model) => modelMatches(operation.model, model.id))) {
    return false;
  }
  return true;
}

function targetForOperation(
  operation: RuntimeOperation,
  targets: RuntimeControlTarget[],
  attempt: ActionAttempt | null,
): RuntimeControlTarget | null {
  if (attempt && operationMatchesAttempt(operation, attempt, targets)) return attempt.target;
  if (!operation.runtime && !operation.model) return null;
  return targets.find((target) =>
    (!operation.runtime || runtimeNameInGroup(operation.runtime, target.group, targets))
    && (!operation.model || target.models.some((model) => modelMatches(operation.model, model.id)))) ?? null;
}

function runtimeMatchesProfile(
  runtime: MacRuntime,
  target: RuntimeControlTarget,
  modelId: string | undefined,
  targets: RuntimeControlTarget[],
): boolean {
  return isActiveModelRuntime(runtime)
    && runtimeInGroup(runtime, target.group, targets)
    && modelMatches(runtime.model, modelId);
}

function targetForServing(
  targets: RuntimeControlTarget[],
  serving: MacRuntime[] | null | undefined,
): RuntimeControlTarget | null {
  if (!Array.isArray(serving)) return null;
  return targets.find((target) => {
    const modelId = target.models[0]?.id;
    return serving.some((runtime) => runtimeMatchesProfile(runtime, target, modelId, targets));
  }) ?? null;
}

interface RuntimeLauncherProps {
  sparkId: string;
  metricsRuntimes?: MacRuntime[] | null;
  agentOnline?: boolean | null;
  className?: string;
  load?: Load;
  start?: Act;
  stop?: (sparkId: string, runtime: string) => Promise<RuntimeControlView>;
}

export function RuntimeLauncher(props: RuntimeLauncherProps) {
  return <RuntimeLauncherForNode key={props.sparkId} {...props} />;
}

function RuntimeLauncherForNode({
  sparkId,
  metricsRuntimes,
  agentOnline,
  className,
  load = fetchRuntimeControl,
  start = startMacRuntime,
  stop = stopMacRuntime,
}: RuntimeLauncherProps) {
  const [status, setStatus] = useState<RuntimeControlView | null>(null);
  const [group, setGroup] = useState<string>("");
  const [targetName, setTargetName] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [picked, setPicked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [unresolvedAction, setUnresolvedAction] = useState<ActionAttempt | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOutput, setActionOutput] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const actionLock = useRef(false);
  const activeActionRef = useRef<ActionAttempt | null>(null);
  const consumedOperationRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setPicked(false);
    setGroup("");
    setTargetName("");
    setModelId("");
    activeActionRef.current = null;
    setUnresolvedAction(null);
    setActionError(null);
    setActionOutput(null);
    setActionNotice(null);
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

  const remoteBusy = Boolean(status?.busy || status?.operation?.state === "running");
  const effectiveBusy = submitting || remoteBusy || unresolvedAction !== null;
  const hasStatus = status !== null;
  const pendingBaseline = effectiveBusy && activeActionRef.current != null
    && status?.operation?.id === activeActionRef.current.baselineOperationId;

  useEffect(() => {
    if (submitting || !hasStatus) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await load(sparkId);
        if (!cancelled) {
          if (!next.transportError) setStatus(next);
          const attempt = activeActionRef.current;
          if (
            attempt
            && !next.transportError
            && next.state === "ready"
            && !next.busy
            && next.operation?.state !== "running"
          ) {
            const matchingCompletion = next.operation?.state === "complete"
              && operationMatchesAttempt(next.operation, attempt, next.targets);
            if (!matchingCompletion) {
              activeActionRef.current = null;
              setUnresolvedAction(null);
              setActionOutput(null);
              setActionNotice(null);
              setActionError(attempt.transportFailed
                ? `The agent is idle with no completion record for ${attempt.target.label}. Request outcome is unknown; check serving status before retrying.`
                : `The agent is idle without a completion result for ${attempt.target.label}. Check serving status before retrying.`);
            }
          }
        }
      } catch {
        // Keep the last authoritative view and any pending lock until a fresh GET resolves it.
      } finally { pending = false; }
    };
    const delay = remoteBusy || unresolvedAction ? BUSY_POLL_MS : NORMAL_POLL_MS;
    const timer = window.setInterval(() => void refresh(), delay);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sparkId, load, submitting, hasStatus, remoteBusy, unresolvedAction]);

  const targets = status?.targets ?? [];
  const groups = useMemo(() => groupsOf(targets), [targets]);
  const groupTargets = targets.filter((target) => target.group === (group || groups[0]?.id));
  const selected = groupTargets.find((target) => target.name === targetName) ?? groupTargets[0] ?? null;
  const models = selected?.models ?? [];
  const selectedModel = models.find((model) => model.id === modelId) ?? models[0] ?? null;

  // A control response is a fresh process probe. It takes precedence over the
  // metrics snapshot, which can lag a start or stop by a full polling cycle.
  // An offline agent or a snapshot that explicitly says it could not read the
  // runtimes is newer knowledge that nothing was proven, so neither is ever
  // answered with a stale serving list.
  const serving = agentOnline === false || metricsRuntimes === null
    ? null
    : status
      ? status.serving
      : metricsRuntimes !== undefined
        ? metricsRuntimes
        : null;

  useEffect(() => {
    if (picked || targets.length === 0) return;
    const match = targetForServing(targets, serving);
    const next = match ?? targets[0];
    setGroup(next.group);
    setTargetName(next.name);
    setModelId(next.models[0]?.id ?? "");
  }, [picked, serving, targets]);

  const selectedModelServing = Boolean(
    selected
    && selectedModel
    && Array.isArray(serving)
    && serving.some((runtime) => runtimeMatchesProfile(runtime, selected, selectedModel.id, targets)),
  );
  const otherModelServing = Boolean(
    Array.isArray(serving)
    && serving.some((runtime) => isActiveModelRuntime(runtime) && !(
      selected
      && selectedModel
      && runtimeMatchesProfile(runtime, selected, selectedModel.id, targets)
    )),
  );
  const ready = status?.state === "ready" && !effectiveBusy;
  const canLaunch = Boolean(selected?.startable && Array.isArray(serving) && !selectedModelServing);
  const canStop = Boolean(selected?.stoppable && selectedModelServing);
  const actionType = selectedModelServing ? "stop" : otherModelServing ? "switch" : "launch";
  const showAction = status?.state === "ready" && (canLaunch || canStop || effectiveBusy);

  useEffect(() => {
    const operation = status?.operation;
    if (!operation || operation.state !== "complete" || status?.busy) return;

    const signature = `${operation.id}:${operation.state}`;
    const attempt = activeActionRef.current;
    if (attempt && operation.id === attempt.baselineOperationId) return;
    if (attempt && !operationMatchesAttempt(operation, attempt, targets)) return;

    const target = targetForOperation(operation, targets, attempt);
    const expectedModel = operation.model ?? attempt?.model ?? target?.models[0]?.id;
    const operationActionName = operationAction(operation.action) ?? attempt?.action ?? null;
    const confirmedServing = Boolean(
      target
      && expectedModel
      && Array.isArray(status.serving)
      && status.serving.some((runtime) =>
        runtime.state === "serving" && runtimeMatchesProfile(runtime, target, expectedModel, targets)),
    );

    if (consumedOperationRef.current === signature) {
      if (operation.ok === true && operationActionName === "start" && confirmedServing) {
        setActionError((current) => current?.startsWith(LOST_RESPONSE_PREFIX) ? null : current);
        setActionNotice((current) => current?.startsWith(START_UNCONFIRMED_PREFIX) ? SERVING_NOTICE : current);
      }
      return;
    }
    consumedOperationRef.current = signature;
    setActionOutput(operation.output?.trim() || null);

    if (operation.ok !== true) {
      setActionError(operation.error || status.error || "Runtime operation failed");
      setActionNotice(null);
    } else if (operationActionName === "start") {
      if (confirmedServing) {
        setActionError(null);
        setActionNotice(SERVING_NOTICE);
      } else {
        setActionNotice(Array.isArray(status.serving)
          ? `${START_UNCONFIRMED_PREFIX} the selected profile is not confirmed serving yet.`
          : "Start command completed, but serving status is unavailable; startup is not confirmed.");
      }
    } else if (operationActionName === "stop" && target && expectedModel) {
      const stillServing = Array.isArray(status.serving) && status.serving.some((runtime) =>
        runtimeMatchesProfile(runtime, target, expectedModel, targets));
      if (stillServing) {
        setActionNotice("Stop command completed, but the selected profile is still reported serving.");
      } else if (Array.isArray(status.serving)) {
        setActionError((current) => current?.startsWith(LOST_RESPONSE_PREFIX) ? null : current);
        setActionNotice("Stop command completed; the selected profile is no longer reported serving.");
      } else {
        setActionNotice("Stop command completed, but serving status is unavailable.");
      }
    } else {
      setActionNotice("Runtime operation completed; serving status was refreshed.");
    }

    if (attempt && operationMatchesAttempt(operation, attempt, targets)) {
      activeActionRef.current = null;
      setUnresolvedAction(null);
    }
  }, [status?.operation?.id, status?.operation?.state, status?.busy, status?.serving, status?.error, targets]);

  // Keep the previous P2 behavior: a success notice disappears if a later
  // authoritative probe no longer reports the selected profile serving.
  useEffect(() => {
    if (actionNotice === SERVING_NOTICE && status?.state === "ready" && !effectiveBusy && !selectedModelServing) {
      setActionNotice(null);
    }
  }, [actionNotice, status?.state, effectiveBusy, selectedModelServing]);

  function showActionResult(result: RuntimeControlView, attempt: ActionAttempt) {
    setActionOutput(result.output?.trim() || null);
    if (result.state === "denied" || result.state === "unavailable") {
      setActionError(result.reason || result.error || "Runtime control refused the action");
    } else if (result.ok !== true) {
      setActionError(result.error || result.reason || "Runtime control did not confirm a successful action");
    } else if (attempt.action === "stop") {
      if (!Array.isArray(result.serving)) {
        setActionNotice("Stop command completed, but serving status is unavailable.");
      } else if (result.serving.some((runtime) => runtimeMatchesProfile(runtime, attempt.target, attempt.model, result.targets))) {
        setActionNotice("Stop command completed, but the selected profile is still reported serving.");
      } else {
        setActionError(null);
        setActionNotice("Stop command completed; the selected profile is no longer reported serving.");
      }
    } else {
      const confirmed = Boolean(
        attempt.model
        && Array.isArray(result.serving)
        && result.serving.some((runtime) => runtime.state === "serving"
          && runtimeMatchesProfile(runtime, attempt.target, attempt.model, result.targets)),
      );
      setActionError(null);
      setActionNotice(confirmed
        ? SERVING_NOTICE
        : Array.isArray(result.serving)
          ? `${START_UNCONFIRMED_PREFIX} the selected profile is not confirmed serving yet.`
          : "Start command completed, but serving status is unavailable; startup is not confirmed.");
    }
  }

  async function onAction() {
    if (!selected || actionLock.current || effectiveBusy) return;
    const stopping = selectedModelServing;
    if (stopping ? !selected.stoppable : !selected.startable || !Array.isArray(serving)) return;
    const attempt: ActionAttempt = {
      action: stopping ? "stop" : "start",
      model: selectedModel?.id,
      target: selected,
      baselineOperationId: status?.operation?.id,
      transportFailed: false,
    };
    actionLock.current = true;
    activeActionRef.current = attempt;
    setPicked(true);
    setSubmitting(true);
    setUnresolvedAction(null);
    setActionError(null);
    setActionOutput(null);
    setActionNotice(null);
    try {
      const result = stopping
        ? await stop(sparkId, selected.name)
        : await start(sparkId, selected.name, selectedModel?.id);
      if (!result.transportError) setStatus(result);
      setActionError(null);
      setActionOutput(null);
      setActionNotice(null);

      if (result.transportError) {
        const unresolved = { ...attempt, transportFailed: true };
        activeActionRef.current = unresolved;
        setUnresolvedAction(unresolved);
        const reason = result.error || result.reason || "runtime request failed";
        setActionError(`${LOST_RESPONSE_PREFIX} ${reason}. Checking agent status before allowing another action.`);
      } else if (result.operation?.state === "complete") {
        // The operation effect consumes the authoritative terminal result once.
      } else if (result.busy || result.operation?.state === "running") {
        // The agent accepted the request. Keep controls locked and poll its status.
      } else if (result.ok === true || result.ok === false || result.state !== "ready") {
        showActionResult(result, attempt);
        activeActionRef.current = null;
      } else {
        setUnresolvedAction(attempt);
        setActionError("The agent returned no operation result. Checking status before allowing another action.");
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Runtime control action failed";
      const unresolved = { ...attempt, transportFailed: true };
      activeActionRef.current = unresolved;
      setUnresolvedAction(unresolved);
      setActionError(`${LOST_RESPONSE_PREFIX} ${reason}. Checking agent status before allowing another action.`);
    } finally {
      actionLock.current = false;
      setSubmitting(false);
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
    <Panel title="Models" icon={<BotIcon className="h-4 w-4" />} className={`panel-runtime-launcher ${className || ""}`}>
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
                disabled={effectiveBusy}
                onChange={(event) => {
                  const nextGroup = event.target.value;
                  const next = targets.find((target) => target.group === nextGroup);
                  setPicked(true);
                  setGroup(nextGroup);
                  setTargetName(next?.name ?? "");
                  setModelId(next?.models[0]?.id ?? "");
                  setActionError(null);
                  setActionOutput(null);
                  setActionNotice(null);
                }}
              >
                {groups.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] text-muted">
              Profile
              <select
                className={`${fieldClass} mt-1`}
                value={selected?.name ?? ""}
                disabled={effectiveBusy}
                onChange={(event) => {
                  const next = targets.find((target) => target.name === event.target.value);
                  setPicked(true);
                  setTargetName(next?.name ?? "");
                  setModelId(next?.models[0]?.id ?? "");
                  setActionError(null);
                  setActionOutput(null);
                  setActionNotice(null);
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
        {status?.state === "ready" && selected && (
          <p className="text-[11px] text-muted" data-testid="runtime-launcher-selection">
            Profile: {selected.name}
            {selectedModel?.id ? ` · Model ID: ${selectedModel.id}` : ""}
          </p>
        )}
        {otherModelServing && actionType === "switch" && (
          <p className="text-[11px] text-muted" data-testid="runtime-launcher-switch-notice">
            Switching profiles stops the current model first.
          </p>
        )}
        {showAction && (
          <button
            type="button"
            data-action={actionType}
            disabled={!ready || !(canLaunch || canStop)}
            onClick={() => void onAction()}
            className={`self-start rounded-md border bg-surface-elevated px-3 py-1.5 text-[11px] disabled:opacity-50 ${
              actionType === "stop"
                ? "border-danger/40 text-danger hover:bg-danger/10"
                : "border-border text-text hover:bg-surface-hover"
            }`}
          >
            {effectiveBusy ? "Working…" : actionType === "stop" ? "Stop" : actionType === "switch" ? "Switch" : "Launch"}
          </button>
        )}
        {effectiveBusy && (
          <p className="text-[11px] text-muted" role="status" data-testid="runtime-launcher-progress">
            {unresolvedAction?.transportFailed
              ? "The action response was lost; checking agent status before allowing another action…"
              : "Running the runtime command and waiting for the serving probe…"}
          </p>
        )}
        {status?.state === "ready" && !showAction && !effectiveBusy && (
          <p className="text-[11px] text-muted">
            {serving === null
              ? "Not launching blind — serving status is unavailable."
              : selected?.reason || "No launch command is configured for this runtime."}
          </p>
        )}
        {actionNotice && (
          <p className="text-[12px] text-muted" role="status" data-testid="runtime-launcher-notice">
            {actionNotice}
          </p>
        )}
        {actionError && (
          <p className="whitespace-pre-wrap text-[12px] text-danger" data-testid="runtime-launcher-error">
            {actionError}
          </p>
        )}
        <ModelOutput operationId={pendingBaseline ? undefined : status?.operation?.id}
          output={pendingBaseline ? "" : status?.operation?.output ?? actionOutput ?? ""} running={effectiveBusy} />
      </div>
    </Panel>
  );
}
