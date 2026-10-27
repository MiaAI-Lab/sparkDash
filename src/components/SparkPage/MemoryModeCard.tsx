import { useCallback, useEffect, useState } from "react";
import { fetchMemoryMode, setMemoryMode } from "../../api/client";
import type { MemoryModeStatus } from "../../api/types";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { Panel } from "../ui/Panel";
import { Tag, type TagTone } from "../ui/Tag";
import { RotateIcon } from "../ui/icons";
import "../../styles/spark.css";

const STATUS_REFRESH_MS = 15_000;

function stateTone(state: string): TagTone {
  if (state === "running") return "good";
  if (state === "exited") return "neutral";
  if (state === "missing") return "bad";
  return "warn";
}

/**
 * Qwen ⇄ Ollama exclusive-stack switcher for the local unit. Two buttons start one
 * stack only after the other is verified stopped — the server refuses a launch below
 * the memory floor and verifies real container state, never a script's word. The card
 * renders only when GET /api/memory-mode reports enabled:true (MEMORY_MODE_ENABLED),
 * so ordinary installs never see it.
 */
export function MemoryModeCard() {
  const [status, setStatus] = useState<MemoryModeStatus | null>(null);
  const [confirming, setConfirming] = useState<"qwen" | "ollama" | null>(null);
  const [switching, setSwitching] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchMemoryMode());
    } catch {
      // Keep the last honest state; a failed poll is not evidence the stack went down.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!switching) void refresh();
    }, STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, switching]);

  async function runSwitch(mode: "qwen" | "ollama") {
    setSwitching(true);
    setMsg(null);
    try {
      const res = await setMemoryMode(mode);
      // The server's message names what happened to each stack — show it verbatim.
      setMsg({ text: res.message, tone: res.status === "success" ? "ok" : "err" });
    } catch (err: unknown) {
      setMsg({ text: err instanceof Error ? err.message : "Memory mode switch failed", tone: "err" });
    } finally {
      setSwitching(false);
      setConfirming(null);
      void refresh();
    }
  }

  if (!status || !status.enabled) return null;
  const busy = status.busy || switching;
  const stackNames = status.ollamaStack.map((c) => c.name);
  const belowFloor = status.availableGb != null && status.availableGb < status.memoryFloorGb;

  const warnings =
    confirming === "ollama"
      ? ["Switching away from Qwen interrupts any session served by the local Qwen engine (including Hermes chat)."]
      : [`The Ollama stack (${stackNames.join(", ") || "not configured"}) will be stopped and must fully exit first.`,
         `Qwen only launches once ${status.memoryFloorGb} GB stays available; below that the switch is refused.`];

  return (
    <Panel
      title="Memory mode"
      hint="Qwen and the Ollama stack are exclusive — each reserves most of the unified pool. Every step is verified by real container state."
      className="sp-memory-mode"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`btn btn--sm${status.mode === "qwen" ? " btn--primary" : ""}`}
          disabled={busy}
          onClick={() => {
            setMsg(null);
            setConfirming("qwen");
          }}
          title={`Start the Qwen stack and stop the Ollama stack (${stackNames.join(", ")})`}
        >
          Qwen stack
          <Tag tone={stateTone(status.qwen ?? "missing")} className="sp-btn-sub">{status.qwen ?? "?"}</Tag>
        </button>
        <button
          type="button"
          className={`btn btn--sm${status.mode === "ollama" ? " btn--primary" : ""}`}
          disabled={busy}
          onClick={() => {
            setMsg(null);
            setConfirming("ollama");
          }}
          title="Stop Qwen, then start the Ollama stack"
        >
          Ollama stack
          {status.ollamaStack.map((c) => (
            <Tag key={c.name} tone={stateTone(c.state)} className="sp-btn-sub" title={`${c.name}: ${c.state}`}>
              {c.name.replace(/^(spark-|chat-)/, "")} {c.state}
            </Tag>
          ))}
        </button>
        <span
          className={`sp-muted mono${belowFloor ? " text-danger" : ""}`}
          title={`MemAvailable on the host. Qwen is only launched when at least ${status.memoryFloorGb} GB stays free.`}
        >
          {status.availableGb == null ? "RAM unmeasured" : `${status.availableGb} GB free`} · floor {status.memoryFloorGb} GB
        </span>
        {busy && (
          <span className="sp-flash text-warning">
            <RotateIcon className="h-3.5 w-3.5 animate-spin" />
            Switching stacks…
          </span>
        )}
      </div>
      {status.problem && <div className="sp-flash text-warning mt-1">{status.problem}</div>}
      {msg && (
        <div className={`sp-flash mt-1 ${msg.tone === "ok" ? "text-success" : "text-danger"}`}>{msg.text}</div>
      )}

      <ConfirmShutdownDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => runSwitch(confirming === "ollama" ? "ollama" : "qwen")}
        title={confirming === "ollama" ? "Switch to the Ollama stack" : "Switch to the Qwen stack"}
        description={
          confirming === "ollama"
            ? "Stop Qwen (stop.sh) and start the Ollama stack? The switch only reports success after every container state is verified."
            : "Stop the Ollama stack and launch Qwen (start.sh)? The switch refuses to launch below the memory floor."
        }
        confirmLabel={confirming === "ollama" ? "Switch to Ollama" : "Switch to Qwen"}
        confirmPhrase="switch"
        footnote="The switcher verifies container state and settled memory at every step; a false 'stopped/started' report is impossible."
        warnings={warnings}
      />
    </Panel>
  );
}
