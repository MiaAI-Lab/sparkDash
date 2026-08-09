import { useState, useCallback } from "react";
import type { StorageMetrics } from "../../api/types";
import { updateDisabledDevices, refreshSparkMetric, updateSpark } from "../../api/client";
import { Panel } from "../ui/Panel";
import { DiskIcon, GearIcon, RotateIcon } from "../ui/icons";

interface StoragePanelProps {
  storage: StorageMetrics[];
  sparkId: string;
  disabledDevices: string[];
  onDisabledChange: (devices: string[]) => void;
  storagePollDisabled?: boolean;
  onStoragePollModeChange?: (disabled: boolean) => void;
}

function formatBytesPerSec(bps: number): string {
  if (bps >= 1024 * 1024 * 1024) return `${(bps / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

function formatGb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(0)} GB`;
  return `${Math.round(mb)} MB`;
}

function TierBadge({ tier }: { tier?: "hot" | "warm" | "cold" }) {
  if (tier !== "hot" && tier !== "warm" && tier !== "cold") return null;
  const label = tier === "hot" ? "Hot" : tier === "warm" ? "Warm" : "Cold";
  const cls =
    tier === "hot"
      ? "bg-accent text-black"
      : tier === "warm"
        ? "bg-warning text-black"
        : "bg-muted text-black";
  return (
    <span
      className={`inline-block shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function MetricBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const barColor = pct > 85 ? "bg-danger" : pct > 60 ? "bg-warning" : "bg-accent";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-border">
      <div
        className={`metric-bar-fill h-full rounded-full transition-[width] duration-300 ease-out ${barColor}`}
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
      className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-border"
      }`}
      aria-pressed={checked}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-3.5" : "translate-x-0.5"
        }`}
      />
    </button>
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
  return (
    <button
      type="button"
      title={active ? "Done" : `${label} settings`}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50 ${
        active ? "bg-surface-elevated text-text" : ""
      }`}
    >
      <GearIcon />
      <span>{active ? "Done" : "Settings"}</span>
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

  return (
    <Panel
      title="Storage"
      accent
      icon={<DiskIcon />}
      className="panel-storage"
      actions={
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh storage"
            aria-label="Refresh storage"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <RotateIcon className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
          <SettingsButton
            active={showSettings}
            onClick={() => setShowSettings(!showSettings)}
            disabled={saving}
            label="Storage"
          />
        </div>
      }
    >
      {showSettings ? (
        <div className="space-y-2">
          <p className="mb-1 text-[10px] text-muted">Toggle devices on/off:</p>
          {storage.length === 0 ? (
            <p className="text-xs text-muted">No disks discovered</p>
          ) : (
            storage.map((disk) => {
              const isDisabled =
                disk.disabled === true ||
                disabledDevices.includes(disk.device) ||
                disabledDevices.includes(disk.label);
              return (
                <div
                  key={`${disk.device}:${disk.label}`}
                  className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs text-text">{disk.device}</span>
                    <span className="shrink-0 text-[10px] text-muted">({disk.label})</span>
                  </div>
                  <Toggle checked={!isDisabled} onChange={(v) => handleToggle(disk.device, !v)} />
                </div>
              );
            })
          )}

          <div className="border-t border-border pt-2">
            <label className="flex items-center justify-between text-xs text-muted">
              <span>Auto-refresh</span>
              <Toggle
                checked={!storagePollDisabled}
                onChange={(on) => {
                  setShowSettings(false);
                  onStoragePollModeChange?.(!on);
                }}
              />
            </label>
            <p className="mt-0.5 text-[10px] text-muted">
              {storagePollDisabled
                ? "Refresh manually using the button above"
                : "Updates every few seconds"}
            </p>
          </div>
        </div>
      ) : (
        <>
          {visibleDisks.length === 0 ? (
            <p className="text-xs text-muted">No mounted disks</p>
          ) : (
            <div className="space-y-3.5">
              {visibleDisks.map((disk) => {
                const pct = disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0;
                return (
                  <div key={`${disk.device}:${disk.label}`} className="space-y-1.5">
                    <div className="flex items-baseline justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-xs text-text">{disk.label}</span>
                        <TierBadge tier={disk.tier} />
                        <span className="shrink-0 font-tabular text-xs text-muted">{disk.device}</span>
                      </div>
                      <span className="shrink-0 font-tabular text-xs text-text-strong">{pct}%</span>
                    </div>
                    <MetricBar value={disk.used} max={disk.total} />
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-tabular text-muted">
                        {formatGb(disk.used)} / {formatGb(disk.total)}
                      </span>
                      <span className="font-tabular text-muted">
                        {formatGb(disk.available)} free
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-3 text-[10px]">
                      <span className="font-tabular text-muted">
                        <span className="text-accent">↑</span> {formatBytesPerSec(disk.writeSpeed || 0)}
                      </span>
                      <span className="font-tabular text-muted">
                        <span className="text-accent">↓</span> {formatBytesPerSec(disk.readSpeed || 0)}
                      </span>
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