import { useState } from "react";
import type { NetworkMetrics } from "../../api/types";
import { updateDisabledInterfaces } from "../../api/client";
import { Panel } from "../ui/Panel";
import { NetworkIcon, GearIcon } from "../ui/icons";

interface NetworkPanelProps {
  network: NetworkMetrics | null;
  sparkId: string;
  disabledInterfaces: string[];
  onDisabledChange: (interfaces: string[]) => void;
  className?: string;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024 * 1024) return `${(bytesPerSec / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${bytesPerSec} B/s`;
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

export function NetworkPanel({
  network,
  sparkId,
  disabledInterfaces,
  onDisabledChange,
  className,
}: NetworkPanelProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);

  const interfaces = network?.interfaces ?? [];
  const primary = network?.primaryInterface ?? null;
  const linkSpeed = network?.linkSpeedMbps ?? null;

  const handleToggle = async (name: string, disabled: boolean) => {
    const next = disabled
      ? [...new Set([...disabledInterfaces, name])]
      : disabledInterfaces.filter((n) => n !== name);

    setSaving(true);
    try {
      await updateDisabledInterfaces(sparkId, next);
      onDisabledChange(next);
    } catch (err) {
      console.error("Failed to update disabled interfaces:", err);
    } finally {
      setSaving(false);
    }
  };

  const visible = interfaces.filter(
    (iface) => !iface.disabled && !disabledInterfaces.includes(iface.name)
      && iface.operstate === "up" && iface.ip
  );

  const primaryVisible =
    primary && !disabledInterfaces.includes(primary) ? primary : null;

  return (
    <Panel
      title="Network"
      accent
      icon={<NetworkIcon />}
      className={`panel-network ${className ?? ""}`}
      actions={
        <button
          type="button"
          title={showSettings ? "Done" : "Interface settings"}
          onClick={() => setShowSettings(!showSettings)}
          disabled={saving}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50 ${
            showSettings ? "bg-surface-elevated text-text" : ""
          }`}
        >
          <GearIcon />
          <span>{showSettings ? "Done" : "Settings"}</span>
        </button>
      }
    >
      {showSettings ? (
        <div className="space-y-2">
          <p className="mb-1 text-[10px] text-muted">Toggle adapters to monitor:</p>
          {interfaces.length === 0 ? (
            <p className="text-xs text-muted">No interfaces discovered</p>
          ) : (
            interfaces.map((iface) => {
              const isDisabled =
                iface.disabled === true || disabledInterfaces.includes(iface.name);
              return (
                <div
                  key={iface.name}
                  className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs text-text">{iface.name}</span>
                    {primary === iface.name && (
                      <span className="shrink-0 rounded bg-accent-soft px-1 text-[9px] font-medium uppercase tracking-wide text-accent">
                        primary
                      </span>
                    )}
                  </div>
                  <Toggle checked={!isDisabled} onChange={(on) => handleToggle(iface.name, !on)} />
                </div>
              );
            })
          )}
        </div>
      ) : (
        <>
          {primaryVisible && (
            <div className="mb-3 flex items-center gap-2 text-xs">
              <span className="text-muted">Primary</span>
              <span className="font-tabular text-text-strong">{primaryVisible}</span>
              {linkSpeed != null && (
                <span className="ml-auto chip py-0.5">{linkSpeed} Mbps</span>
              )}
            </div>
          )}
          <div className="space-y-2">
            {visible.length === 0 ? (
              <p className="text-xs text-muted">
                {interfaces.length === 0 ? "No interfaces" : "All adapters hidden — open settings"}
              </p>
            ) : (
              visible.map((iface) => {
                const isPrimary = iface.name === primary;
                return (
                  <div
                    key={iface.name}
                    className={`flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between rounded-md border px-3 py-2 ${
                      isPrimary
                        ? "border-accent/40 bg-accent-soft"
                        : "border-border bg-surface-elevated"
                    }`}
                  >
                    <span className={`flex items-center gap-2 text-xs ${isPrimary ? "text-text-strong" : "text-text"}`}>
                      {iface.ip ? (
                        <span className="font-tabular truncate">{iface.ip}</span>
                      ) : (
                        <span className="truncate">{iface.name}</span>
                      )}
                    </span>
                    <span className="font-tabular text-xs text-text">
                      <span className="text-accent">↑</span> {formatSpeed(iface.txSpeed)}
                      <span className="mx-1.5 text-border">·</span>
                      <span className="text-accent">↓</span> {formatSpeed(iface.rxSpeed)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </Panel>
  );
}