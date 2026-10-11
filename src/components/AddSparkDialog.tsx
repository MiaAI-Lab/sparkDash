import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { addSpark, testSparkConfig } from "../api/client";
import type { SparkConfig, SparkTestResponse } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { CheckIcon, ChevronRightIcon, XIcon } from "./ui/icons";
import {
  ADD_STEPS,
  canAdvance,
  connectIssue,
  parsePorts,
  rolePatch,
  slugifyId,
  stepLabel,
  validateConnect,
  type AddStep,
} from "./addSparkSteps";
import { addDeviceLabel, UNIT_TYPE_OPTIONS, unitTypeOf, unitTypePatch, type UnitType } from "../shared/deviceKind";
import { TestResultList } from "./TestResultList";
import { resolveSparkRole } from "../api/sparkRole";
import type { SparkRole } from "../api/types";
import "../styles/dialogs.css";

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
  role: "standalone",
  comfyMonitoring: false,
  comfyPort: 8188,
  hermesMonitoring: false,
  lanIp: "",
  cx7Ip: "",
  isLocal: false,
  llmPorts: [8888],
  ssh: { host: "", user: "zurih", auth: "key", port: 22 },
};

function sshPortValue(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 22;
}

function Stepper({ step }: { step: AddStep }) {
  const { t } = useTranslation();
  return (
    <ol className="stepper" aria-label={t("spark.add.progress", "Progress")}>
      {ADD_STEPS.map((key, i) => (
        <li
          key={key}
          className={`stepper__item${i < step ? " is-done" : ""}${i === step ? " is-current" : ""}`}
          aria-current={i === step ? "step" : undefined}
        >
          <b>{i < step ? <CheckIcon className="h-3 w-3" /> : i + 1}</b>
          <span>{stepLabel(i as AddStep)}</span>
          {i < ADD_STEPS.length - 1 && <hr aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

export function AddSparkDialog({ open, onClose, onAdded, defaultLlmPort = 8888 }: AddSparkDialogProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState(defaultConfig);
  const [step, setStep] = useState<AddStep>(0);
  const [portsText, setPortsText] = useState(String(defaultLlmPort));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SparkTestResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscape(onClose);

  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  // Pre-fill LLM ports from settings when dialog opens; always start at step 1.
  useEffect(() => {
    if (open) {
      setConfig((prev) => ({ ...prev, llmPorts: [defaultLlmPort] }));
      setPortsText(String(defaultLlmPort));
      setStep(0);
      setError(null);
    }
  }, [open, defaultLlmPort]);

  if (!mounted) return null;

  const update = (patch: Partial<Omit<SparkConfig, "id">>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  };

  const updateSsh = (patch: Partial<SparkConfig["ssh"]>) => {
    setConfig((prev) => ({ ...prev, ssh: { ...prev.ssh, ...patch } }));
  };

  const role = resolveSparkRole(config);

  const roleCards: Array<{ id: SparkRole; label: string; hint: string }> = [
    {
      id: "standalone",
      label: t("spark.role.standalone", "Standalone"),
      hint: t("spark.role.standaloneHint", "Runs its own LLM"),
    },
    {
      id: "head",
      label: t("spark.role.head", "Head"),
      hint: t("spark.role.headHint", "Leads a cluster"),
    },
    {
      id: "worker",
      label: t("spark.role.worker", "Worker"),
      hint: t("spark.role.workerHint", "Shard only, no local API"),
    },
  ];

  const buildPayload = (): SparkConfig => {
    // Password problems must surface as an error before the request; the
    // Connect-step "Next" gate keeps the form disabled until they are fixed.
    if (connectIssue(config) === "password") throw new Error(validateConnect(config)!);
    return {
      ...config,
      id: slugifyId(config.name),
      ssh: {
        ...config.ssh,
        // Always set host from lanIp when empty
        host: config.ssh.host || config.lanIp,
        port: sshPortValue(config.ssh.port),
      },
    };
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const payload = buildPayload();
      // Ephemeral test — no registry mutation
      const result = await testSparkConfig(payload);
      setTestResult(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
      setStep(0);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (!canAdvance(step, config)) return;
    setError(null);
    setStep((s) => (Math.min(2, s + 1) as AddStep));
  };
  const back = () => {
    setError(null);
    setStep((s) => (Math.max(0, s - 1) as AddStep));
  };

  const stepReady = canAdvance(step, config);

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-spark-title"
      >
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id="add-spark-title">
            {t("spark.add.title", "Add Spark/GPU Host")}
          </h2>
          <button
            type="button"
            className="modal-sheet__close"
            onClick={onClose}
            aria-label={t("common.action.close", "Close")}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body modal-sheet__stack">
          <Stepper step={step} />

          {step === 0 && (
            <>
              <div className="field">
                <label htmlFor="add-spark-kind">{t("spark.field.unitType", "Unit type")}</label>
                <select
                  id="add-spark-kind"
                  value={unitTypeOf(config)}
                  onChange={(e) => update(unitTypePatch(e.target.value as UnitType, config))}
                >
                  <option value="spark">{t("spark.kindOption.spark", "NVIDIA DGX Spark")}</option>
                  <option value="host">
                    {t("spark.kindOption.host", "Dedicated GPU host (Linux, nvidia-smi, not a Spark)")}
                  </option>
                  <option value="windows">
                    {t("spark.kindOption.windows", "Windows PC with an NVIDIA GPU (OpenSSH, nvidia-smi)")}
                  </option>
                </select>
              </div>

              {config.platform !== "windows" && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={config.isLocal}
                    onChange={(e) => update({ isLocal: e.target.checked })}
                  />
                  <span>{t("spark.add.thisHost", "This host (local collectors, no SSH for metrics)")}</span>
                </label>
              )}
              {config.platform === "windows" && (
                <p className="field-hint">
                  {t(
                    "spark.add.windowsHint",
                    "Needs the Windows OpenSSH Server and the NVIDIA driver (nvidia-smi). Metrics come from PowerShell over SSH; Hermes and Tailnet checks are not available for Windows."
                  )}
                </p>
              )}

              <div className="field">
                <label htmlFor="add-spark-lan-ip">
                  {t("spark.field.lanIp", "LAN IP")}{" "}
                  {config.isLocal
                    ? config.kind === "host"
                      ? t("spark.add.lanIpOptWol", "(optional, browser links and Wake-on-LAN)")
                      : t("spark.add.lanIpOpt", "(optional, browser links)")
                    : t("spark.field.required", "(required)")}
                </label>
                <input
                  id="add-spark-lan-ip"
                  type="text"
                  value={config.lanIp}
                  onChange={(e) => update({ lanIp: e.target.value })}
                  placeholder="192.168.1.100"
                />
                {config.isLocal && !config.lanIp && (
                  <p className="field-hint">
                    {config.kind === "host"
                      ? t(
                          "spark.hint.localMetricsHost",
                          "Local metrics still work. Open links and directed Wake-on-LAN need a LAN IP."
                        )
                      : t(
                          "spark.hint.localMetricsSpark",
                          "Local metrics still work. Open links need a LAN IP. DGX Spark has no Wake-on-LAN."
                        )}
                  </p>
                )}
              </div>

              {config.kind !== "host" && (
                <div className="field">
                  <label htmlFor="add-spark-cx7">{t("spark.field.cx7", "CX7 IP (optional)")}</label>
                  <input
                    id="add-spark-cx7"
                    type="text"
                    value={config.cx7Ip || ""}
                    onChange={(e) => update({ cx7Ip: e.target.value || null })}
                    placeholder="10.0.0.1"
                  />
                </div>
              )}

              {!config.isLocal && (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="add-spark-ssh-user">{t("spark.field.sshUser", "SSH User")}</label>
                      <input
                        id="add-spark-ssh-user"
                        type="text"
                        value={config.ssh.user}
                        onChange={(e) => updateSsh({ user: e.target.value })}
                      />
                    </div>
                    <div className="field field--port">
                      <label htmlFor="add-spark-ssh-port">{t("spark.field.sshPort", "SSH Port")}</label>
                      <input
                        id="add-spark-ssh-port"
                        type="number"
                        min={1}
                        max={65535}
                        inputMode="numeric"
                        value={config.ssh.port ?? 22}
                        onChange={(e) => updateSsh({ port: sshPortValue(e.target.value) })}
                      />
                    </div>
                  </div>
                  <p className="field-hint">
                    {t("spark.add.sshPortHint", "Default port 22. Change it when sshd listens elsewhere.")}
                  </p>

                  <div className="field">
                    <label htmlFor="add-spark-ssh-auth">{t("spark.field.sshAuth", "SSH Auth")}</label>
                    <select
                      id="add-spark-ssh-auth"
                      value={config.ssh.auth}
                      onChange={(e) => updateSsh({ auth: e.target.value as "key" | "pass" })}
                    >
                      <option value="key">{t("spark.field.authKey", "Key")}</option>
                      <option value="pass">{t("spark.field.authPassword", "Password")}</option>
                    </select>
                    {config.ssh.auth === "key" && (
                      <p className="field-hint">
                        {t(
                          "spark.add.sshKeyHint",
                          "SSH runs on the sparkDash host (not your browser). In Docker, mount a private key at /root/.ssh/id_ed25519 (see docker-compose.yml) or set SSH_IDENTITY_FILE. IPs are from that host's network. Mark this machine as “This host” so it skips SSH."
                        )}
                      </p>
                    )}
                  </div>

                  {config.ssh.auth === "pass" && (
                    <div className="field">
                      <label htmlFor="add-spark-ssh-password">{t("spark.field.sshPassword", "SSH Password")}</label>
                      <input
                        id="add-spark-ssh-password"
                        type="password"
                        value={config.ssh.password || ""}
                        onChange={(e) => updateSsh({ password: e.target.value })}
                        autoComplete="new-password"
                      />
                      <p className="field-hint">
                        {t(
                          "spark.add.sshPasswordHint",
                          "Stored encrypted on the server (not in sparks.json, not returned by the API). Survives Docker restarts."
                        )}
                      </p>
                    </div>
                  )}
                </>
              )}

              <div className="test-block">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={handleTest}
                  disabled={testing || (!config.isLocal && !config.lanIp)}
                >
                  {testing ? t("common.action.testing", "Testing...") : t("common.action.test", "Test")}
                </button>
                <span className="field-hint">
                  {t("spark.add.testHint", "Checks SSH, hardware and LLM before you add it. Optional.")}
                </span>
              </div>
              {testResult && <TestResultList result={testResult} />}
            </>
          )}

          {step === 1 && (
            <>
              <div className="field">
                <span className="field-label" id="add-spark-role-label">
                  {t("spark.add.howUse", "How will you use it?")}
                </span>
                <div className="role-opts" role="radiogroup" aria-labelledby="add-spark-role-label">
                  {roleCards.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      role="radio"
                      aria-checked={role === r.id}
                      className={`role-opt${role === r.id ? " is-on" : ""}`}
                      onClick={() => update(rolePatch(r.id))}
                    >
                      {r.label}
                      <small>{r.hint}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label htmlFor="add-spark-name">{t("spark.add.nameRequired", "Name (required)")}</label>
                <input
                  id="add-spark-name"
                  type="text"
                  value={config.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder={t("spark.field.namePlaceholder", "My Spark")}
                  autoFocus
                />
                <p className="text-[11px] text-muted">
                  {t("spark.add.nameHint", "Shown in the sidebar and on the Overview.")}
                </p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {role !== "worker" ? (
                <div className="field">
                  <label htmlFor="add-spark-llm-ports">
                    {t("spark.add.llmPorts", "LLM ports (optional, comma-separated)")}
                  </label>
                  <input
                    id="add-spark-llm-ports"
                    type="text"
                    value={portsText}
                    onChange={(e) => {
                      setPortsText(e.target.value);
                      const ports = parsePorts(e.target.value);
                      if (ports.length > 0) update({ llmPorts: ports });
                    }}
                    placeholder={String(defaultLlmPort)}
                  />
                  <p className="field-hint">
                    {t("spark.hint.llmPortsDefault", "Default: {port}", { port: defaultLlmPort })}
                  </p>
                </div>
              ) : (
                <p className="field-hint">
                  {t("spark.add.workersNoPorts", "Workers have no local LLM API, so no ports are probed.")}
                </p>
              )}

              <div className="set-row">
                <div className="set-row__text">
                  <span className="set-row__title">{t("spark.add.monitorComfy", "Monitor ComfyUI")}</span>
                  <small>
                    {t("spark.add.monitorComfyHint", "Job queue and live progress. Default port 8188.")}
                  </small>
                </div>
                <div className="set-row__control">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(config.comfyMonitoring)}
                    aria-label={t("spark.add.monitorComfy", "Monitor ComfyUI")}
                    onClick={() =>
                      update({ comfyMonitoring: !config.comfyMonitoring, comfyPort: config.comfyPort ?? 8188 })
                    }
                    className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors${
                      config.comfyMonitoring ? " is-on" : ""
                    }`}
                  >
                    <span
                      className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                        config.comfyMonitoring ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {config.platform !== "windows" && (
                <div className="set-row">
                  <div className="set-row__text">
                    <span className="set-row__title">
                      {t("spark.add.monitorHermes", "Monitor Hermes updates")}
                    </span>
                    <small>
                      {t(
                        "spark.add.monitorHermesHint",
                        "Checks for new releases every 10 min and adds an Update Hermes button."
                      )}
                    </small>
                  </div>
                  <div className="set-row__control">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(config.hermesMonitoring)}
                      aria-label={t("spark.add.monitorHermes", "Monitor Hermes updates")}
                      onClick={() => update({ hermesMonitoring: !config.hermesMonitoring })}
                      className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors${
                        config.hermesMonitoring ? " is-on" : ""
                      }`}
                    >
                      <span
                        className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                          config.hermesMonitoring ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {error && <div className="modal-sheet__error">{error}</div>}
        </div>

        <div className="modal-sheet__footer">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            {t("common.action.cancel", "Cancel")}
          </button>
          <div className="modal-sheet__footer-actions">
            {step > 0 && (
              <button type="button" onClick={back} className="btn btn--ghost">
                {t("common.action.back", "Back")}
              </button>
            )}
            {step < 2 ? (
              <button type="button" onClick={next} disabled={!stepReady} className="btn btn--primary">
                {t("spark.add.next", "Next: {step}", { step: stepLabel((step + 1) as AddStep) })}
                <ChevronRightIcon className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !stepReady}
                className="btn btn--primary"
              >
                {saving ? t("common.action.saving", "Saving...") : addDeviceLabel(config.kind)}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
