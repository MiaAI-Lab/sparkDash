import { useState } from "react";
import type { NetworkMetrics } from "../../api/types";
import { updateDisabledInterfaces } from "../../api/client";
import { Panel } from "../ui/Panel";
import { NetworkIcon, GearIcon } from "../ui/icons";
import { TrendLine } from "../ui/TrendLine";
import { Tag } from "../ui/Tag";
import { formatBytesPerSec } from "../../shared/formatBytes";
import { useLocalSeries } from "./useLocalSeries";

/** "12.3 MB/s" → big number + unit for the headline readout. */
function splitRate(bps: number): { value: string; unit: string } {
  const [value, ...unit] = formatBytesPerSec(bps).split(" ");
  return { value, unit: unit.join(" ") };
}

interface NetworkPanelProps {
  network: NetworkMetrics | null;
  sparkId: string;
  disabledInterfaces: string[];
  onDisabledChange: (interfaces: string[]) => void;
  className?: string;
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

  // Headline rates: the primary adapter, else the sum of every visible adapter.
  const primaryRows = visible.filter((i) => i.name === primaryVisible);
  const headline = primaryRows.length > 0 ? primaryRows : visible;
  const rx = headline.reduce((a, i) => a + (i.rxSpeed || 0), 0);
  const tx = headline.reduce((a, i) => a + (i.txSpeed || 0), 0);
  const rxHistory = useLocalSeries(`${sparkId}:rx`, rx, network);
  const txHistory = useLocalSeries(`${sparkId}:tx`, tx, network);
  const rxFmt = splitRate(rx);
  const txFmt = splitRate(tx);

  return (
    <Panel
      title="Network"
      accent
      icon={<NetworkIcon />}
      className={`panel-network ${className ?? ""}`}
      bodyClassName="sp-stack"
      actions={
        <button
          type="button"
          title={showSettings ? "Done" : "Interface settings"}
          onClick={() => setShowSettings(!showSettings)}
          disabled={saving}
          className={`btn btn--sm btn--ghost ${showSettings ? "is-on" : ""}`}
        >
          <GearIcon />
          <span>{showSettings ? "Done" : "Settings"}</span>
        </button>
      }
    >
      {showSettings ? (
        <div className="sp-stack">
          <p className="sp-hint">Toggle adapters to monitor:</p>
          {interfaces.length === 0 ? (
            <p className="sp-muted">No interfaces discovered</p>
          ) : (
            interfaces.map((iface) => {
              const isDisabled =
                iface.disabled === true || disabledInterfaces.includes(iface.name);
              return (
                <div
                  key={iface.name}
                  className="sp-list-row"
                >
                  <div className="sp-list-row__main">
                    <span className="sp-clip">{iface.name}</span>
                    {primary === iface.name && <Tag tone="acc">primary</Tag>}
                  </div>
                  <Toggle checked={!isDisabled} onChange={(on) => handleToggle(iface.name, !on)} />
                </div>
              );
            })
          )}
        </div>
      ) : (
        <>
          <div className="sp-decode">
            <div className="sp-metric">
              <span className="eyebrow">Download</span>
              <div className="big-num sp-big-md">
                {rxFmt.value}
                <small>{rxFmt.unit}</small>
              </div>
              <TrendLine data={rxHistory} height={36} color="var(--color-success)" />
            </div>
            <div className="sp-metric">
              <span className="eyebrow">Upload</span>
              <div className="big-num sp-big-md">
                {txFmt.value}
                <small>{txFmt.unit}</small>
              </div>
              <TrendLine data={txHistory} height={36} color="var(--color-violet)" />
            </div>
          </div>
          {primaryVisible && (
            <div className="sp-row">
              <span className="text-muted">Primary</span>
              <span className="sp-chips">
                <span className="mono text-text">{primaryVisible}</span>
                {linkSpeed != null && <Tag>{linkSpeed} Mbps</Tag>}
              </span>
            </div>
          )}
          <div className="sp-list">
            {visible.length === 0 ? (
              <p className="sp-muted">
                {interfaces.length === 0 ? "No interfaces" : "All adapters hidden — open settings"}
              </p>
            ) : (
              visible.map((iface) => {
                const isPrimary = iface.name === primary;
                return (
                  <div key={iface.name} className={`sp-list-row ${isPrimary ? "is-primary" : ""}`}>
                    <span className="mono sp-clip">{iface.ip || iface.name}</span>
                    <span className="mono sp-nowrap">
                      <span className="text-accent">↑</span> {formatBytesPerSec(iface.txSpeed)}
                      <span className="sp-sep">·</span>
                      <span className="text-accent">↓</span> {formatBytesPerSec(iface.rxSpeed)}
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