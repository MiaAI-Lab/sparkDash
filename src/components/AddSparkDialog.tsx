import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { addSpark, testSparkConfig } from "../api/client";
import type { SparkConfig, SparkTestResponse } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useOverlayClose } from "../hooks/useOverlayClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { CheckIcon, ChevronRightIcon, XIcon } from "./ui/icons";
import {
  canAdvance,
  parsePorts,
  rolePatch,
  slugifyId,
  validateConnect,
  type AddStep,
} from "./addSparkSteps";
import { UNIT_TYPE_OPTIONS, unitTypeOf, unitTypePatch, type UnitType } from "../shared/deviceKind";
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
  const { t } = useTranslation("devices");
  const labels = [t("addSteps.connect"), t("addSteps.role"), t("addSteps.services")];
  return (
            <ol className="stepper" aria-label={t("add.progress")}>
      {labels.map((label, i) => (
        <li
          key={label}
          className={`stepper__item${i < step ? " is-done" : ""}${i === step ? " is-current" : ""}`}
          aria-current={i === step ? "step" : undefined}
        >
          <b>{i < step ? <CheckIcon className="h-3 w-3" /> : i + 1}</b>
          <span>{label}</span>
          {i < labels.length - 1 && <hr aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

/** One-click ports for common servers. They only fill a port number; nothing is installed. */
const SERVER_PRESETS = [
  { name: "LM Studio", port: 1234 },
  { name: "Ollama", port: 11434 },
  { name: "TensorFold", port: 8888 },
] as const;

export function AddSparkDialog({ open, onClose, onAdded, defaultLlmPort = 8888 }: AddSparkDialogProps) {
  const { t } = useTranslation("devices");
  const roleCards: Array<{ id: SparkRole; label: string; hint: string }> = [
    { id: "standalone", label: t("add.standalone"), hint: t("add.standaloneHint") },
    { id: "head", label: t("add.head"), hint: t("add.headHint") },
    { id: "worker", label: t("add.worker"), hint: t("add.workerHint") },
  ];
  const stepLabels = [t("addSteps.connect"), t("addSteps.role"), t("addSteps.services")];
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
  const overlayClose = useOverlayClose(onClose);

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

  /** Add a server's default port to the list (the untouched default port is replaced), keeping the text field in step. */
  const addPresetPort = (port: number) => {
    const current = parsePorts(portsText);
    const untouched = current.length === 1 && current[0] === defaultLlmPort;
    const next = untouched || current.length === 0 ? [port] : current.includes(port) ? current : [...current, port];
    setPortsText(next.join(", "));
    update({ llmPorts: next });
  };

  const updateSsh = (patch: Partial<SparkConfig["ssh"]>) => {
    setConfig((prev) => ({ ...prev, ssh: { ...prev.ssh, ...patch } }));
  };

  const role = resolveSparkRole(config);

  const buildPayload = (): SparkConfig => {
    const connectError = validateConnect(config);
    if (connectError && connectError.startsWith("Password")) throw new Error(connectError);
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
      {...overlayClose}
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
            {t("add.title")}
          </h2>
          <button type="button" className="modal-sheet__close" onClick={onClose} aria-label={t("actions.close")}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body modal-sheet__stack">
          <Stepper step={step} />

          {step === 0 && (
            <>
              <div className="field">
                <label htmlFor="add-spark-kind">{t("fields.unitType")}</label>
                <select
                  id="add-spark-kind"
                  value={unitTypeOf(config)}
                  onChange={(e) => update(unitTypePatch(e.target.value as UnitType, config))}
                >
                  {UNIT_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.value === "spark" ? t("unitTypes.spark") : o.value === "host" ? t("unitTypes.host") : t("unitTypes.windows")}</option>
                  ))}
                </select>
              </div>

              {config.platform !== "windows" && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={config.isLocal}
                    onChange={(e) => update({ isLocal: e.target.checked })}
                  />
                  <span>{t("add.thisHost")}</span>
                </label>
              )}
              {config.platform === "windows" && (
                <p className="field-hint">
                  {t("add.windowsHint")}
                </p>
              )}

              <div className="field">
                <label htmlFor="add-spark-lan-ip">
                  {t("fields.lanIp")}{" "}
                  {config.isLocal
                    ? config.kind === "host"
                      ? t("add.lanIpOptionalWol")
                      : t("add.lanIpOptional")
                    : t("add.required")}
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
                    {t("add.localMetrics")}
                    {config.kind === "host"
                      ? t("add.localHostHint")
                      : t("add.localSparkHint")}
                  </p>
                )}
              </div>

              {config.kind !== "host" && (
                <div className="field">
                  <label htmlFor="add-spark-cx7">{t("fields.cx7")}</label>
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
                      <label htmlFor="add-spark-ssh-user">{t("fields.sshUser")}</label>
                      <input
                        id="add-spark-ssh-user"
                        type="text"
                        value={config.ssh.user}
                        onChange={(e) => updateSsh({ user: e.target.value })}
                      />
                    </div>
                    <div className="field field--port">
                      <label htmlFor="add-spark-ssh-port">{t("fields.sshPort")}</label>
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
                  <p className="field-hint">{t("add.sshPortHint")}</p>

                  <div className="field">
                    <label htmlFor="add-spark-ssh-auth">{t("fields.sshAuth")}</label>
                    <select
                      id="add-spark-ssh-auth"
                      value={config.ssh.auth}
                      onChange={(e) => updateSsh({ auth: e.target.value as "key" | "pass" })}
                    >
                      <option value="key">{t("fields.key")}</option>
                      <option value="pass">{t("fields.password")}</option>
                    </select>
                    {config.ssh.auth === "key" && (
                      <p className="field-hint">
                        {t("add.sshKeyHint")}
                      </p>
                    )}
                  </div>

                  {config.ssh.auth === "pass" && (
                    <div className="field">
                      <label htmlFor="add-spark-ssh-password">{t("fields.sshPassword")}</label>
                      <input
                        id="add-spark-ssh-password"
                        type="password"
                        value={config.ssh.password || ""}
                        onChange={(e) => updateSsh({ password: e.target.value })}
                        autoComplete="new-password"
                      />
                      <p className="field-hint">
                        {t("add.sshPasswordHint")}
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
                  {testing ? t("actions.testing") : t("actions.test")}
                </button>
                <span className="field-hint">{t("add.testHint")}</span>
              </div>
              {testResult && <TestResultList result={testResult} />}
            </>
          )}

          {step === 1 && (
            <>
              <div className="field">
                <span className="field-label" id="add-spark-role-label">
                  {t("add.howUse")}
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
                <label htmlFor="add-spark-name">{t("add.nameRequired")}</label>
                <input
                  id="add-spark-name"
                  type="text"
                  value={config.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder={t("add.namePlaceholder")}
                  autoFocus
                />
                <p className="text-[11px] text-muted">{t("add.nameHint")}</p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {role !== "worker" ? (
                <div className="field">
                  <label htmlFor="add-spark-llm-ports">{t("add.llmPorts")}</label>
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
                  <p className="field-hint">{t("add.defaultPort", { port: defaultLlmPort })}</p>
                  <div role="group" aria-label={t("add.serverPresets")} className="sp-btns">
                    <span className="eyebrow">{t("add.presets")}</span>
                    {SERVER_PRESETS.map((preset) => (
                      <button
                        key={preset.port}
                        type="button"
                        className="btn btn--sm"
                        title={t("add.presetTitle", { name: preset.name, port: preset.port })}
                        onClick={() => addPresetPort(preset.port)}
                      >
                        {preset.name} :{preset.port}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="field-hint">{t("add.workersNoPorts")}</p>
              )}

              <div className="set-row">
                <div className="set-row__text">
                  <span className="set-row__title">{t("add.monitorComfy")}</span>
                  <small>{t("add.monitorComfyHint")}</small>
                </div>
                <div className="set-row__control">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(config.comfyMonitoring)}
                    aria-label={t("add.monitorComfy")}
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
                    <span className="set-row__title">{t("add.monitorHermes")}</span>
                    <small>{t("add.monitorHermesHint")}</small>
                  </div>
                  <div className="set-row__control">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(config.hermesMonitoring)}
                      aria-label={t("add.monitorHermes")}
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
            {t("actions.cancel")}
          </button>
          <div className="modal-sheet__footer-actions">
            {step > 0 && (
              <button type="button" onClick={back} className="btn btn--ghost">
                {t("actions.back")}
              </button>
            )}
            {step < 2 ? (
              <button type="button" onClick={next} disabled={!stepReady} className="btn btn--primary">
                {t("add.next", { step: stepLabels[step + 1] })}
                <ChevronRightIcon className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !stepReady}
                className="btn btn--primary"
              >
                {saving ? t("actions.saving") : config.kind === "host" ? t("deviceLabels.addHost") : t("deviceLabels.addSpark")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
