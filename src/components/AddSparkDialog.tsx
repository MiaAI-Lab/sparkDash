import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { addSpark, testSparkConfig } from "../api/client";
import type { SparkConfig } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";

interface AddSparkDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  defaultLlmPort?: number;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

const defaultConfig: Omit<SparkConfig, "id"> = {
  name: "",
  kind: "spark",
  lanIp: "",
  cx7Ip: "",
  isLocal: false,
  llmPorts: [8888],
  ssh: { host: "", user: "zurih", auth: "key" },
};

export function AddSparkDialog({ open, onClose, onAdded, defaultLlmPort = 8888 }: AddSparkDialogProps) {
  const [config, setConfig] = useState(defaultConfig);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscape(onClose);

  const { mounted, visible } = useModalPresence(open);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  // Pre-fill LLM ports from settings when dialog opens
  useEffect(() => {
    if (open) {
      setConfig((prev) => ({ ...prev, llmPorts: [defaultLlmPort] }));
    }
  }, [open, defaultLlmPort]);

  if (!mounted) return null;

  const update = (patch: Partial<Omit<SparkConfig, "id">>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  };

  const updateSsh = (patch: Partial<SparkConfig["ssh"]>) => {
    setConfig((prev) => ({ ...prev, ssh: { ...prev.ssh, ...patch } }));
  };

  const buildPayload = (): SparkConfig => {
    const id = config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || `spark-${Date.now()}`;
    const auth = config.ssh.auth;
    if (!config.isLocal && auth === "pass" && !config.ssh.password) {
      throw new Error("Password is required when SSH auth is Password");
    }
    return {
      ...config,
      id,
      ssh: {
        ...config.ssh,
        // Always set host from lanIp when empty
        host: config.ssh.host || config.lanIp,
      },
    };
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const payload = buildPayload();
      // Ephemeral test — no registry mutation
      const result = await testSparkConfig(payload);
      const parts: string[] = [];
      if (result.ssh.ok) parts.push("SSH ✓");
      else parts.push(`SSH ✗ ${result.ssh.message}`);
      if (result.llm.ok) parts.push("LLM ✓");
      else parts.push(`LLM ✗ ${result.llm.message}`);

      setTestResult({
        ok: result.ok,
        message: result.ok ? "Connection successful" : parts.join(" | "),
      });
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      await addSpark(payload);
      onAdded();
      setConfig(defaultConfig);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-spark-title"
      >
        <div className="modal-sheet__header" id="add-spark-title">
          Add Spark/GPU Host
        </div>

        <div className="modal-sheet__body">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted">Unit type</label>
            <select
              value={config.kind ?? "spark"}
              onChange={(e) => update({ kind: e.target.value as "spark" | "host" })}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            >
              <option value="spark">NVIDIA DGX Spark</option>
              <option value="host">Dedicated GPU host (Linux, nvidia-smi, not a Spark)</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted">Name</label>
            <input
              type="text"
              value={config.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              placeholder="My Spark"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted">LAN IP</label>
            <input
              type="text"
              value={config.lanIp}
              onChange={(e) => update({ lanIp: e.target.value })}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              placeholder="192.168.1.100"
            />
          </div>

          {config.kind !== "host" && (
            <div>
              <label className="mb-1 block text-xs text-muted">CX7 IP (optional)</label>
              <input
                type="text"
                value={config.cx7Ip || ""}
                onChange={(e) => update({ cx7Ip: e.target.value || null })}
                className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                placeholder="10.0.0.1"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted">LLM Ports (optional, comma-separated)</label>
            <input
              type="text"
              value={(config.llmPorts ?? [defaultLlmPort]).join(", ")}
              onChange={(e) => {
                const ports = e.target.value
                  .split(",")
                  .map((s) => parseInt(s.trim(), 10))
                  .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
                if (ports.length > 0) update({ llmPorts: ports });
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              placeholder={String(defaultLlmPort)}
            />
            <p className="mt-1 text-[10px] text-muted">
              Default: {defaultLlmPort}
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={config.isLocal}
              onChange={(e) => update({ isLocal: e.target.checked })}
              className="rounded border-border"
            />
            This host (local collectors — no SSH for metrics)
          </label>

          {!config.isLocal && (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted">SSH User</label>
                <input
                  type="text"
                  value={config.ssh.user}
                  onChange={(e) => updateSsh({ user: e.target.value })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted">SSH Auth</label>
                <select
                  value={config.ssh.auth}
                  onChange={(e) => updateSsh({ auth: e.target.value as "key" | "pass" })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                >
                  <option value="key">Key</option>
                  <option value="pass">Password</option>
                </select>
                {config.ssh.auth === "key" && (
                  <p className="mt-1 text-[10px] text-muted">
                    SSH runs on the sparkDash host (not your browser). In Docker, mount a private
                    key at /root/.ssh/id_ed25519 (see docker-compose.yml) or set SSH_IDENTITY_FILE.
                    IPs are from that host&apos;s network. Mark this machine as “This host” so it
                    skips SSH.
                  </p>
                )}
              </div>

              {config.ssh.auth === "pass" && (
                <div>
                  <label className="mb-1 block text-xs text-muted">SSH Password</label>
                  <input
                    type="password"
                    value={config.ssh.password || ""}
                    onChange={(e) => updateSsh({ password: e.target.value })}
                    className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                    autoComplete="new-password"
                  />
                  <p className="mt-1 text-[10px] text-muted">
                    Stored encrypted on the server (not in sparks.json, not returned by the API).
                    Survives Docker restarts.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {testResult && (
          <div className={`mt-3 rounded px-3 py-2 text-xs ${testResult.ok ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}`}>
            {testResult.message}
          </div>
        )}

        {error && (
          <div className="mt-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">{error}</div>
        )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !config.lanIp}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              {testing ? "Testing..." : "Test"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !config.name || !config.lanIp}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
