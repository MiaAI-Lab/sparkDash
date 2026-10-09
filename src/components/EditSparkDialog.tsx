import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  deleteSpark,
  fetchSparks,
  setSparkPassword,
  testSpark,
  testSparkConfig,
  updateSpark,
} from "../api/client";
import type { SparkConfig, SparkRole, SparkTestResponse } from "../api/types";
import { resolveSparkRole } from "../api/sparkRole";
import { useModalPresence } from "../hooks/useModalPresence";
import { InfoIcon } from "./ui/icons";
import { TestResultList } from "./TestResultList";
import { XIcon } from "./ui/icons";
import "../styles/dialogs.css";

interface EditSparkDialogProps {
  open: boolean;
  sparkId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted?: (id: string) => void;
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

export function EditSparkDialog({
  open,
  sparkId,
  onClose,
  onSaved,
  onDeleted,
}: EditSparkDialogProps) {
  const [config, setConfig] = useState<SparkConfig | null>(null);
  /** Snapshot of the Spark config as last fetched from the server. Used to
   *  detect form-vs-saved divergence so Test can target what the user is
   *  actually looking at (vs. the stored config the registered test route
   *  would read). */
  const [savedConfig, setSavedConfig] = useState<SparkConfig | null>(null);
  /** All Sparks — used for the worker head picker. */
  const [allSparks, setAllSparks] = useState<SparkConfig[]>([]);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<SparkTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedPasswordNote, setSavedPasswordNote] = useState<string | null>(null);

  useEscape(onClose);

  const { mounted, visible } = useModalPresence(open);

  // Prevent background scroll while the tall form is open (iOS)
  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  useEffect(() => {
    if (!open || !sparkId) {
      setConfig(null);
      setSavedConfig(null);
      setAllSparks([]);
      setPassword("");
      setTestResult(null);
      setError(null);
      setSavedPasswordNote(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchSparks()
      .then((res) => {
        if (cancelled) return;
        setAllSparks(res.sparks);
        const found = res.sparks.find((s) => s.id === sparkId) || null;
        setConfig(found);
        setSavedConfig(found);
        if (!found) setError("Spark not found");
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sparkId]);

  if (!mounted) return null;

  const role: SparkRole = resolveSparkRole(config ?? {});

  const update = (patch: Partial<SparkConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const setRole = (next: SparkRole) => {
    update({
      role: next,
      workerNode: next === "worker",
      // Leaving Worker: turn monitoring back on (worker forces it false in state).
      llmMonitoring: next === "worker" ? false : next === "head" ? true : true,
    });
  };

  const updateSsh = (patch: Partial<SparkConfig["ssh"]>) => {
    setConfig((prev) => (prev ? { ...prev, ssh: { ...prev.ssh, ...patch } } : prev));
  };

  const needsPassword =
    !config?.isLocal && config?.ssh.auth === "pass" && !config.ssh.hasPassword && !password;

  // The server drops the saved password when the SSH target changes.
  const sshTargetChanged =
    config != null &&
    savedConfig != null &&
    (config.isLocal !== savedConfig.isLocal ||
      (config.ssh.host || config.lanIp) !== (savedConfig.ssh?.host || savedConfig.lanIp) ||
      config.ssh.user !== savedConfig.ssh?.user);

  /** Persist password immediately (host can be offline). */
  const persistPasswordIfEntered = async () => {
    if (!config || !password) return false;
    await setSparkPassword(config.id, password);
    setConfig((prev) =>
      prev
        ? { ...prev, ssh: { ...prev.ssh, hasPassword: true } }
        : prev
    );
    setSavedPasswordNote("Password saved encrypted (works even while host is offline).");
    setPassword(""); // clear field — keep as stored secret
    return true;
  };

  const handleTest = async () => {
    if (!config) return;
    if (!config.isLocal && config.ssh.auth === "pass" && !config.ssh.hasPassword && !password) {
      setError("Enter the SSH password first — it will be saved even if the host is down.");
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      // Always store password before testing so a failed SSH still keeps the secret
      if (password) {
        await setSparkPassword(config.id, password);
        setConfig((prev) =>
          prev ? { ...prev, ssh: { ...prev.ssh, hasPassword: true } } : prev
        );
        setSavedPasswordNote("Password saved.");
      }

      // Decide which route to hit. The registered route (`POST /api/sparks/:id/test`)
      // is preferred — it reads the already-stored password from server memory so the
      // secret never transits the wire twice. BUT it tests the *persisted* Spark
      // config, while the user may be staring at a form with unsaved edits (e.g. a
      // new LAN IP). When any host-side field diverges from what's on disk, fall
      // back to the ephemeral test path so we test what the user is actually
      // looking at. Password-only changes do NOT count as dirty: the password was
      // already persisted above via setSparkPassword, so the registered route can
      // read it from memory — sending it again via testSparkConfig would duplicate
      // the wire transit (the exact pattern H7 was written to remove).
      const formDirty =
        !savedConfig ||
        config.lanIp !== savedConfig.lanIp ||
        (config.cx7Ip ?? null) !== (savedConfig.cx7Ip ?? null) ||
        config.isLocal !== savedConfig.isLocal ||
        (config.ssh?.host || config.lanIp) !== (savedConfig.ssh?.host || savedConfig.lanIp) ||
        config.ssh?.user !== savedConfig.ssh?.user ||
        config.ssh?.auth !== savedConfig.ssh?.auth ||
        (config.ssh?.port ?? 22) !== (savedConfig.ssh?.port ?? 22) ||
        (config.kind ?? "spark") !== (savedConfig.kind ?? "spark") ||
        config.role !== savedConfig.role ||
        Boolean(config.llmMonitoring) !== Boolean(savedConfig.llmMonitoring) ||
        Boolean(config.comfyMonitoring) !== Boolean(savedConfig.comfyMonitoring) ||
        Boolean(config.hermesMonitoring) !== Boolean(savedConfig.hermesMonitoring) ||
        Boolean(config.tailscaleMonitoring) !== Boolean(savedConfig.tailscaleMonitoring) ||
        (config.comfyPort ?? 8188) !== (savedConfig.comfyPort ?? 8188);

      const result = formDirty
        ? await testSparkConfig({
            ...config,
            ssh: {
              ...config.ssh,
              host: config.ssh.host || config.lanIp,
              password,
            },
          })
        : await testSpark(config.id);

      setTestResult(result);
      // Keep it for Save when the SSH target changed (the edit has to resend it).
      if (password && !sshTargetChanged) setPassword("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    if (!config.isLocal && config.ssh.auth === "pass" && (!config.ssh.hasPassword || sshTargetChanged) && !password) {
      setError("Password required for password-auth Sparks (saved encrypted, host can be offline).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Save password first so it is never lost if the rest of the update fails
      if (password && !sshTargetChanged) {
        await persistPasswordIfEntered();
      }

      const patch: Partial<SparkConfig> = {
        name: config.name,
        kind: config.kind ?? "spark",
        lanIp: config.lanIp,
        cx7Ip: config.cx7Ip,
        macAddress: config.macAddress || null,
        isLocal: config.isLocal,
        role,
        workerNode: role === "worker",
        workerLabel: role === "worker" ? (config.workerLabel?.trim() || null) : null,
        workerHeadId: role === "worker" ? (config.workerHeadId?.trim() || null) : null,
        llmMonitoring:
          role === "worker" ? false : role === "head" ? true : config.llmMonitoring !== false,
        comfyMonitoring: Boolean(config.comfyMonitoring),
        comfyPort: (() => {
          const n = Number(config.comfyPort);
          return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8188;
        })(),
        hermesMonitoring: Boolean(config.hermesMonitoring),
        tailscaleMonitoring: Boolean(config.tailscaleMonitoring),
        ssh: {
          host: config.ssh.host || config.lanIp,
          user: config.ssh.user,
          auth: config.ssh.auth,
          port: (() => {
            const n = Number(config.ssh.port);
            return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 22;
          })(),
          ...(password && sshTargetChanged ? { password } : {}),
        },
      };
      await updateSpark(config.id, patch);
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!config) return;
    if (!confirm(`Remove Spark "${config.name}"? This cannot be undone.`)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteSpark(config.id);
      onDeleted?.(config.id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
        aria-labelledby="edit-spark-title"
      >
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id="edit-spark-title">
            Edit Spark
          </h2>
          <button type="button" className="modal-sheet__close" onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body">
          {loading && <p className="text-xs text-muted">Loading…</p>}

          {config && !loading && (
            <div className="space-y-3">
              <div>
                <label className="field-label">Unit type</label>
                <select
                  value={config.kind ?? "spark"}
                  onChange={(e) => update({ kind: e.target.value as "spark" | "host" })}
                >
                  <option value="spark">NVIDIA DGX Spark</option>
                  <option value="host">Dedicated GPU host (Linux, nvidia-smi, not a Spark)</option>
                </select>
              </div>

              <div>
                <label className="field-label">Name</label>
                <input
                  type="text"
                  value={config.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </div>

              <div>
                <label className="field-label">
                  LAN IP {config.isLocal
                    ? config.kind === "host"
                      ? "(optional — browser links and Wake-on-LAN)"
                      : "(optional — browser links)"
                    : "(required)"}
                </label>
                <input
                  type="text"
                  value={config.lanIp}
                  onChange={(e) => update({ lanIp: e.target.value })}
                />
                {config.isLocal && !config.lanIp && (
                  <p className="field-hint">
                    Local metrics still work.
                    {config.kind === "host"
                      ? " Open links and directed Wake-on-LAN need a LAN IP."
                      : " Open links need a LAN IP. DGX Spark has no Wake-on-LAN."}
                  </p>
                )}
              </div>

              {config.kind !== "host" && (
                <div>
                  <label className="field-label">CX7 IP (optional)</label>
                  <input
                    type="text"
                    value={config.cx7Ip || ""}
                    onChange={(e) => update({ cx7Ip: e.target.value || null })}
                  />
                </div>
              )}

              {config.kind === "host" && (
              <div>
                <label className="field-label">
                  MAC Address (Wake-on-LAN override)
                </label>
                <input
                  type="text"
                  value={config.macAddress || ""}
                  onChange={(e) => update({ macAddress: e.target.value || null })}
                  placeholder={
                    config.detectedMacAddress
                      ? `Auto: ${config.detectedMacAddress}`
                      : "Auto from enP7s7 when online"
                  }
                />
                <p className="field-hint">
                  {config.detectedMacAddress
                    ? `Using enP7s7 automatically (${config.detectedMacAddress}). Leave blank to keep auto, or enter a different MAC.`
                    : "Leave blank to use enP7s7 once the host has been online and detected."}
                </p>
              </div>
              )}

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={config.isLocal}
                  onChange={(e) => update({ isLocal: e.target.checked })}
                  
                />
                This host (local collectors — no SSH for metrics)
              </label>

              <div>
                <label className="field-label field-label--row">
                  <span>Role</span>
                  <span
                    className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
                    title="Head always monitors the local LLM. Standalone can opt in/out. Workers have no local API — the LLM card is hidden and ports are not probed."
                    aria-label="Head always monitors the local LLM. Standalone can opt in or out. Workers hide the LLM card and do not probe ports."
                  >
                    <InfoIcon className="h-3.5 w-3.5" />
                  </span>
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as SparkRole)}
                >
                  <option value="head">Head</option>
                  <option value="worker">Worker</option>
                  <option value="standalone">Standalone</option>
                </select>
              </div>

              {role === "standalone" && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={config.llmMonitoring !== false}
                    onChange={(e) => update({ llmMonitoring: e.target.checked })}
                    
                  />
                  <span>LLM monitoring</span>
                  <span
                    className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
                    title="When enabled, probe the local LLM API and show the LLM card on this Spark."
                    aria-label="Enable probing the local LLM API and showing the LLM card."
                  >
                    <InfoIcon className="h-3.5 w-3.5" />
                  </span>
                </label>
              )}

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(config.comfyMonitoring)}
                    onChange={(e) =>
                      update({
                        comfyMonitoring: e.target.checked,
                        comfyPort: config.comfyPort ?? 8188,
                      })
                    }
                    
                  />
                  <span>ComfyUI monitoring</span>
                  <span
                    className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
                    title="When enabled, probe ComfyUI on this host and show a ComfyUI card. Default port is 8188 — change the port value on the right if needed."
                    aria-label="Enable probing ComfyUI and showing the ComfyUI card."
                  >
                    <InfoIcon className="h-3.5 w-3.5" />
                  </span>
                </label>
                {/* Compact “port 8188” control on the same row. */}
                <div
                  className={`ml-auto flex items-center gap-1 font-tabular ${
                    config.comfyMonitoring ? "text-text" : "pointer-events-none opacity-40"
                  }`}
                  title="ComfyUI HTTP port (default 8188)"
                >
                  <span className="select-none text-muted" aria-hidden>
                    port
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    inputMode="numeric"
                    disabled={!config.comfyMonitoring}
                    aria-label="ComfyUI port"
                    value={config.comfyPort ?? 8188}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (Number.isInteger(n) && n >= 1 && n <= 65535) {
                        update({ comfyPort: n });
                      }
                    }}
                    onBlur={() => {
                      const n = Number(config.comfyPort);
                      if (!Number.isInteger(n) || n < 1 || n > 65535) {
                        update({ comfyPort: 8188 });
                      }
                    }}
                    className="w-14 border-0 bg-transparent px-0.5 py-0.5 text-center font-tabular text-xs text-inherit outline-none focus:rounded focus:bg-surface-elevated focus:ring-1 focus:ring-accent disabled:cursor-not-allowed"
                  />
                </div>
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={Boolean(config.hermesMonitoring)}
                  onChange={(e) => update({ hermesMonitoring: e.target.checked })}
                  
                />
                <span>Hermes Agent</span>
                <span
                  className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
                  title='Hermes Agent CLI is installed on this machine (nousresearch/hermes-agent). When enabled, sparkDash checks for updates (hermes update --check) and can run “hermes update” for you via SSH with one click.'
                  aria-label='Hermes Agent CLI is installed on this machine; enable update monitoring and one-click updates.'
                >
                  <InfoIcon className="h-3.5 w-3.5" />
                </span>
              </label>
              <p className="field-hint">
                Checks for updates in the background (10 min) and adds an "Update Hermes" button
                that runs{" "}
                <code className="rounded bg-surface-elevated px-1">hermes update</code> on this
                machine via SSH.
              </p>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(config.tailscaleMonitoring)}
                    onChange={(e) => update({ tailscaleMonitoring: e.target.checked })}
                    
                  />
                  <span>Tailnet monitoring</span>
                  <span
                    className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
                    title="When enabled, run `tailscale status --json` on this host and show a Tailnet card. Catches a unit that is healthy on the LAN but has fallen off its tailnet. Requires the tailscale CLI. Default off."
                    aria-label="Enable reporting this unit's tailnet presence."
                  >
                    <InfoIcon className="h-3.5 w-3.5" />
                  </span>
                </label>
              </div>

              {role === "worker" && (
                <div className="space-y-3">
                  <div>
                    <label className="field-label">
                      Worker label (cluster / model)
                    </label>
                    <input
                      type="text"
                      value={config.workerLabel || ""}
                      onChange={(e) => update({ workerLabel: e.target.value || null })}
                      placeholder="e.g. DeepSeek V4 Flash"
                    />
                    <p className="field-hint">
                      Shown on the overview card. Leave blank to show “distributed”.
                    </p>
                  </div>

                  <div>
                    <label className="field-label">Head Spark</label>
                    <select
                      value={config.workerHeadId || ""}
                      onChange={(e) => update({ workerHeadId: e.target.value || null })}
                    >
                      <option value="">None</option>
                      {config.workerHeadId &&
                        !allSparks.some((s) => s.id === config.workerHeadId) && (
                          <option value={config.workerHeadId}>
                            Missing spark ({config.workerHeadId})
                          </option>
                        )}
                      {allSparks
                        .filter((s) => s.id !== config.id)
                        .map((s) => {
                          const sRole = resolveSparkRole(s);
                          const suffix =
                            sRole === "head" ? " (Head)" : sRole === "worker" ? " (Worker)" : "";
                          return (
                            <option key={s.id} value={s.id}>
                              {s.name}{suffix}
                            </option>
                          );
                        })}
                    </select>
                    <p className="field-hint">
                      Optional. Which Spark serves as the cluster head for this worker.
                    </p>
                  </div>
                </div>
              )}

              {!config.isLocal && (
                <>
                  <div>
                    <label className="field-label">SSH User</label>
                    <input
                      type="text"
                      value={config.ssh.user}
                      onChange={(e) => updateSsh({ user: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="field-label" htmlFor="edit-spark-ssh-port">
                      SSH Port
                    </label>
                    <input
                      id="edit-spark-ssh-port"
                      type="number"
                      min={1}
                      max={65535}
                      inputMode="numeric"
                      value={config.ssh.port ?? 22}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        updateSsh({
                          port: Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 22,
                        });
                      }}
                    />
                    <p className="field-hint">Default 22. Use this when sshd listens elsewhere.</p>
                  </div>

                  <div>
                    <label className="field-label">SSH Auth</label>
                    <select
                      value={config.ssh.auth}
                      onChange={(e) => updateSsh({ auth: e.target.value as "key" | "pass" })}
                    >
                      <option value="key">Key</option>
                      <option value="pass">Password</option>
                    </select>
                    {config.ssh.auth === "key" && (
                      <p className="field-hint">
                        SSH runs on the sparkDash host. Docker: mount a key at /root/.ssh/id_ed25519
                        (or SSH_IDENTITY_FILE). IPs are from that host, not your laptop.
                      </p>
                    )}
                  </div>

                  {config.ssh.auth === "pass" && (
                    <div>
                      <label className="field-label">
                        SSH Password
                        {config.ssh.hasPassword
                          ? " (leave blank to keep stored secret)"
                          : " (required — saved even if host is offline)"}
                      </label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                        placeholder={config.ssh.hasPassword ? "••••••••" : "Enter password"}
                      />
                      {config.ssh.hasPassword ? (
                        <p className="field-hint">
                          Password is stored encrypted on this server. Offline Sparks still keep it
                          and reconnect automatically when back up.
                        </p>
                      ) : (
                        <p className="field-hint is-warn">
                          Enter once and Save (or Test). Stored encrypted — host does not need to be
                          online.
                        </p>
                      )}
                      {savedPasswordNote && (
                        <p className="field-hint is-ok">{savedPasswordNote}</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {testResult && <TestResultList result={testResult} />}

          {error && (
            <div className="modal-sheet__error">{error}</div>
          )}
        </div>

        <div className="modal-sheet__footer">
          <button
            type="button"
            onClick={handleDelete}
            disabled={saving || loading || !config}
            className="btn btn--danger"
          >
            {saving ? "Removing…" : "Remove"}
          </button>
          <div className="modal-sheet__footer-actions">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || loading || (!config?.isLocal && !config?.lanIp) || needsPassword}
              className="btn"
            >
              {testing ? "Testing..." : "Test"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn btn--ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || !config?.name || (!config?.isLocal && !config?.lanIp) || needsPassword}
              className="btn btn--primary"
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
