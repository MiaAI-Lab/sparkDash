import { useMemo, useState, type ReactNode } from "react";
import "../../../styles/benchpages.css";
import type { LlmBenchTarget, SparkSnapshot } from "../../../api/types";
import {
  formatLlmBaseUrl,
  parseLlmTargetInput,
} from "../../../shared/llmTarget.js";
import { Tag } from "../../ui/Tag";
import { PageEmpty } from "./pageParts";
import { SparkChips, useBenchSparks } from "../SparkChips";
import { useStickyHeight } from "./useStickyHeight";

/** Same key the Spark page's Remote launcher uses, so a typed host carries over. */
const REMOTE_STORAGE_KEY = "sparkdash.remote-bench-target";

function readStoredRemote(): { host: string; port: string; tls: boolean } {
  try {
    const raw = localStorage.getItem(REMOTE_STORAGE_KEY);
    if (!raw) return { host: "", port: "443", tls: true };
    const v = JSON.parse(raw) as {
      host?: string;
      port?: number;
      tls?: boolean;
    };
    return {
      host: typeof v.host === "string" ? v.host : "",
      port: v.port != null ? String(v.port) : "443",
      tls: v.tls !== false,
    };
  } catch {
    return { host: "", port: "443", tls: true };
  }
}

/** What the bench dialogs need to know about where to run, derived from the chosen Spark. */
export interface BenchTargetProps {
  sparkId: string;
  sparkName: string;
  llmPort: number;
  modelId: string | null;
  contextLength: number | null;
  remoteTarget: LlmBenchTarget | null;
  engine: string | null;
  posture: { label: string; level: "ok" | "warn" | "danger" } | null;
  shareImage: boolean;
  /** Live generation tok/s from the monitor; null for a Remote target. */
  liveTps: number | null;
}

const POSTURE_TONE = { ok: "good", warn: "warn", danger: "bad" } as const;

/**
 * Shared top of the sparkDash bench pages: choose the LLM port (or a Remote endpoint) the run
 * targets, explain when the Spark has nothing reachable, then render the bench page body.
 */
export function BenchTargetFrame({
  spark,
  benchShareImage = false,
  children,
}: {
  spark: SparkSnapshot | null;
  benchShareImage?: boolean;
  children: (target: BenchTargetProps) => ReactNode;
}) {
  const benchSparks = useBenchSparks();
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [portPick, setPortPick] = useState<number | null>(null);
  // The remote target the page body was last (re)built for: it changes when the host field loses focus, not on every keystroke.
  const [committedRemote, setCommittedRemote] = useState("");
  const bodyRef = useStickyHeight(`${spark?.id ?? ""}:${mode}:${portPick ?? ""}`);
  const stored = useMemo(readStoredRemote, []);
  const [hostDraft, setHostDraft] = useState(stored.host);
  const [portDraft, setPortDraft] = useState(stored.port);
  const [tls, setTls] = useState(stored.tls);

  const remote = useMemo(() => {
    if (mode !== "remote")
      return {
        target: null as LlmBenchTarget | null,
        error: null as string | null,
      };
    if (!hostDraft.trim())
      return {
        target: null,
        error: "Enter the host of the LLM endpoint to benchmark.",
      };
    try {
      return {
        target: parseLlmTargetInput(
          hostDraft,
          portDraft,
          tls,
        ) as LlmBenchTarget,
        error: null,
      };
    } catch (err) {
      return {
        target: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [mode, hostDraft, portDraft, tls]);

  if (!spark) {
    return (
      <PageEmpty title="No Spark to benchmark">
        Add a Spark from the fleet rail first. Benchmarks run against the LLM
        server on a Spark, or on a Remote endpoint you type in.
      </PageEmpty>
    );
  }

  const ports = spark.llmPorts?.length
    ? spark.llmPorts
    : spark.llmPort
      ? [spark.llmPort]
      : [];
  const portIndex = Math.max(0, portPick != null ? ports.indexOf(portPick) : 0);
  const llmPort = ports[portIndex] ?? spark.llmPort ?? 8888;
  const llm = spark.metrics?.llm?.[portIndex] ?? null;
  const reachable = spark.online && Boolean(llm?.available);

  const persist = (t: LlmBenchTarget) => {
    try {
      localStorage.setItem(REMOTE_STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* private mode */
    }
  };

  const useRemote = mode === "remote";
  const target: BenchTargetProps = {
    sparkId: spark.id,
    sparkName: spark.name,
    llmPort,
    modelId: useRemote ? null : (llm?.modelId ?? null),
    contextLength: useRemote ? null : (llm?.contextLength ?? null),
    remoteTarget: useRemote ? remote.target : null,
    engine: useRemote ? null : (llm?.backend ?? null),
    posture: useRemote ? null : (llm?.posture ?? null),
    shareImage: benchShareImage,
    liveTps: useRemote ? null : (llm?.generationTps ?? null),
  };

  let notice: ReactNode = null;
  if (useRemote) {
    if (remote.error)
      notice = <p className="bench-sheet__error bp-notice">{remote.error}</p>;
  } else if (!spark.online) {
    notice = (
      <p className="bp-notice bp-notice--warn">
        <strong>{spark.name} is offline.</strong> Bring it back online to
        benchmark its LLM, or switch the target to Remote and point at another
        endpoint. Saved runs below are still readable.
      </p>
    );
  } else if (!reachable) {
    notice = (
      <p className="bp-notice bp-notice--warn">
        <strong>No reachable LLM on port {llmPort}.</strong>{" "}
        {llm?.error ? `${llm.error}. ` : ""}Start a model on this Spark (Models
        panel on its page), check the LLM port in its settings, or switch the
        target to Remote.
      </p>
    );
  }

  return (
    <div className="bp">
      <section className="panel bp-target" aria-label="Benchmark target">
        <div className="bp-target__row">
          <span className="eyebrow">Run on</span>
          <SparkChips
            sparks={benchSparks.sparks.length ? benchSparks.sparks : [spark]}
            activeId={useRemote ? null : spark.id}
            onSelect={(id) => {
              setMode("local");
              setPortPick(null);
              benchSparks.onSelect(id);
            }}
            extra={
              <button
                type="button"
                className={`bench-runon__chip${useRemote ? " is-on" : ""}`}
                aria-pressed={useRemote}
                onClick={() => setMode("remote")}
                title="Benchmark another LLM endpoint instead of a Spark's"
              >
                Remote
              </button>
            }
          />

          {!useRemote ? (
            <>
              {ports.length > 1 ? (
                <label className="bp-field">
                  <span className="eyebrow">LLM port</span>
                  <select
                    value={llmPort}
                    onChange={(e) => setPortPick(Number(e.target.value))}
                    aria-label="LLM port"
                  >
                    {ports.map((p, i) => (
                      <option key={p} value={p}>
                        {p}
                        {spark.metrics?.llm?.[i]?.modelId
                          ? ` · ${spark.metrics.llm[i].modelId}`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <Tag>Port {llmPort}</Tag>
              )}
              {llm?.modelId ? (
                <Tag tone="acc" title="Model currently served on this port">
                  {llm.modelId}
                </Tag>
              ) : null}
              {llm?.contextLength ? (
                <Tag>ctx {llm.contextLength.toLocaleString()}</Tag>
              ) : null}
              {llm?.backend ? <Tag>{llm.backend}</Tag> : null}
              {llm?.posture ? (
                <Tag
                  tone={POSTURE_TONE[llm.posture.level]}
                  title={llm.posture.detail}
                >
                  {llm.posture.label}
                </Tag>
              ) : null}
            </>
          ) : remote.target ? (
            <Tag tone="acc">{formatLlmBaseUrl(remote.target)}</Tag>
          ) : null}
        </div>

        {useRemote ? (
          <div className="bp-remote">
            <label className="bp-field bp-field--grow">
              <span className="eyebrow">Host</span>
              <input
                type="text"
                value={hostDraft}
                onChange={(e) => setHostDraft(e.target.value)}
                onBlur={() => {
                  if (remote.target) {
                    persist(remote.target);
                    setCommittedRemote(formatLlmBaseUrl(remote.target));
                    setHostDraft(remote.target.host);
                    setPortDraft(String(remote.target.port));
                    setTls(remote.target.tls);
                  }
                }}
                placeholder="https://name.tailxxxxx.ts.net/v1/models"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Remote host"
              />
            </label>
            <label className="bp-field">
              <span className="eyebrow">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                aria-label="Remote port"
              />
            </label>
            <label className="bp-check">
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTls(next);
                  if (next && portDraft === "8888") setPortDraft("443");
                  if (!next && portDraft === "443") setPortDraft("8888");
                }}
              />
              HTTPS
            </label>
            <p className="bp-hint">
              On-demand endpoint: nothing is probed until you run. Remote units
              use LAN HTTP, or an SSH tunnel to loopback if the server only
              listens on 127.0.0.1.
            </p>
          </div>
        ) : null}
        {notice}
      </section>

      <div ref={bodyRef}>
        {useRemote && !remote.target ? (
          // No valid host yet: show the page as it will look, but inert, so nothing can run against
          // this Spark's own port by mistake.
          <div
            key={`${spark.id}:pending`}
            className="bp-pending"
            inert
            aria-disabled="true"
          >
            {children(target)}
          </div>
        ) : (
          <div
            key={`${spark.id}:${useRemote ? `remote:${committedRemote}` : llmPort}`}
          >
            {children(target)}
          </div>
        )}
      </div>
    </div>
  );
}
