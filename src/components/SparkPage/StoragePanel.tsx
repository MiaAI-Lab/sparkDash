import { useTranslation } from "react-i18next";
import { useState, useCallback } from "react";
import type { StorageMetrics } from "../../api/types";
import { updateDisabledDevices, refreshSparkMetric, updateSpark } from "../../api/client";
import { Panel } from "../ui/Panel";
import { DiskIcon, GearIcon, RotateIcon } from "../ui/icons";
import { formatBytesPerSec, formatGb } from "../../shared/formatBytes";

interface StoragePanelProps {
  storage: StorageMetrics[];
  sparkId: string;
  disabledDevices: string[];
  onDisabledChange: (devices: string[]) => void;
  storagePollDisabled?: boolean;
  onStoragePollModeChange?: (disabled: boolean) => void;
}

function UsageBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const barColor = pct > 85 ? "bg-danger" : pct > 60 ? "bg-warning" : "bg-info";
  return (
    <div className="sp-bar">
      <div
        className={`metric-bar-fill sp-bar__fill ${barColor}`}
        style={{ ["--bar-pct" as string]: `${pct}%` }}
      />
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`sp-toggle ${checked ? "is-on" : ""}`}
      aria-pressed={checked}
    />
  );
}

function SettingsButton({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  const { t } = useTranslation("hardware");
  return (
    <button
      type="button"
      title={active ? t("storage.done") : t("storage.settingsTitle", { label })}
      onClick={onClick}
      disabled={disabled}
      className={`btn btn--sm btn--ghost ${active ? "is-on" : ""}`}
    >
      <GearIcon />
      <span>{active ? t("storage.done") : t("storage.settings")}</span>
    </button>
  );
}

export function StoragePanel({
  storage,
  sparkId,
  disabledDevices,
  onDisabledChange,
  storagePollDisabled = false,
  onStoragePollModeChange,
}: StoragePanelProps) {
  const { t } = useTranslation("hardware");
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshSparkMetric(sparkId, "storage");
    } catch (err) {
      console.error("Failed to refresh storage:", err);
    } finally {
      setRefreshing(false);
    }
  }, [sparkId]);

  const handleToggle = async (device: string, disabled: boolean) => {
    const newDisabled = disabled
      ? [...new Set([...disabledDevices, device])]
      : disabledDevices.filter((d) => d !== device);

    setSaving(true);
    try {
      await updateDisabledDevices(sparkId, newDisabled);
      onDisabledChange(newDisabled);
    } catch (err) {
      console.error("Failed to update disabled devices:", err);
    } finally {
      setSaving(false);
    }
  };

  // Settings: full list. Main view: enabled only.
  const visibleDisks = storage.filter(
    (d) => !d.disabled && !disabledDevices.includes(d.device) && !disabledDevices.includes(d.label)
  );

  const totalRead = visibleDisks.reduce((a, d) => a + (d.readSpeed || 0), 0);
  const totalWrite = visibleDisks.reduce((a, d) => a + (d.writeSpeed || 0), 0);

  return (
    <Panel
      title={t("storage.title")}
      icon={<DiskIcon />}
      className="panel-storage"
      bodyClassName="sp-stack"
      actions={
        <div className="sp-actions">
          {!showSettings && visibleDisks.length > 0 && (
            <span className="mono sp-muted sp-nowrap sp-actions__lead" title={t("storage.throughput")}>
              r {formatBytesPerSec(totalRead)} · w {formatBytesPerSec(totalWrite)}
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title={t("storage.refresh")}
            aria-label={t("storage.refresh")}
            className="btn btn--sm btn--ghost"
          >
            <RotateIcon className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            <span>{refreshing ? t("storage.refreshing") : t("storage.refreshAction")}</span>
          </button>
          <SettingsButton
            active={showSettings}
            onClick={() => setShowSettings(!showSettings)}
            disabled={saving}
            label={t("storage.title")}
          />
        </div>
      }
    >
      {showSettings ? (
        <div className="sp-stack">
          <p className="sp-hint">{t("storage.toggle")}</p>
          {storage.length === 0 ? (
            <p className="sp-muted">{t("storage.noneFound")}</p>
          ) : (
            storage.map((disk) => {
              const isDisabled =
                disk.disabled === true ||
                disabledDevices.includes(disk.device) ||
                disabledDevices.includes(disk.label);
              return (
                <div
                  key={`${disk.device}:${disk.label}`}
                  className="sp-list-row"
                >
                  <div className="sp-list-row__main">
                    <span className="sp-clip">{disk.device}</span>
                    <span className="sp-muted">({disk.label})</span>
                  </div>
                  <Toggle checked={!isDisabled} onChange={(v) => handleToggle(disk.device, !v)} />
                </div>
              );
            })
          )}

          <div className="sp-section">
            <label className="sp-row">
              <span>{t("storage.auto")}</span>
              <Toggle
                checked={!storagePollDisabled}
                onChange={(on) => {
                  setShowSettings(false);
                  onStoragePollModeChange?.(!on);
                }}
              />
            </label>
            <p className="sp-hint">
              {storagePollDisabled
                ? t("storage.manual")
                : t("storage.autoHint")}
            </p>
          </div>
        </div>
      ) : (
        <>
          {visibleDisks.length === 0 ? (
            <p className="sp-muted">{t("storage.noneMounted")}</p>
          ) : (
            <div className="sp-stack">
              {visibleDisks.map((disk) => {
                return (
                  <div key={`${disk.device}:${disk.label}`}>
                    <div className="sp-lbl">
                      <span className="sp-clip">
                        {disk.label} · {disk.device}
                      </span>
                      <b>
                        {formatGb(disk.used)} / {formatGb(disk.total)}
                      </b>
                    </div>
                    <UsageBar value={disk.used} max={disk.total} />
                    <div className="sp-lbl sp-lbl--sub">
                      <span className="mono">
                        <span className="text-accent">↑</span> {formatBytesPerSec(disk.writeSpeed || 0)}
                        <span className="sp-sep">·</span>
                        <span className="text-accent">↓</span> {formatBytesPerSec(disk.readSpeed || 0)}
                      </span>
                      <span className="mono">{t("storage.free", { value: formatGb(disk.available) })}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}