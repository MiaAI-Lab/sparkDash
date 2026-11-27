import { useTranslation } from "react-i18next";
import { useState, useCallback } from "react";
import type { StorageCategoryMetric, StorageMetrics } from "../../api/types";
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

/** camelCase category id → kebab-case CSS suffix (icloudDrive → icloud-drive). */
function categoryClass(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function categoryLabel(t: (key: string) => string, id: string): string {
  switch (id) {
    case "applications":
      return t("storage.categories.applications");
    case "developer":
      return t("storage.categories.developer");
    case "documents":
      return t("storage.categories.documents");
    case "photos":
      return t("storage.categories.photos");
    case "media":
      return t("storage.categories.media");
    case "mail":
      return t("storage.categories.mail");
    case "messages":
      return t("storage.categories.messages");
    case "icloudDrive":
      return t("storage.categories.icloudDrive");
    case "iosFiles":
      return t("storage.categories.iosFiles");
    case "trash":
      return t("storage.categories.trash");
    case "systemData":
      return t("storage.categories.systemData");
    default:
      return id;
  }
}

/** Categories with measured usage; empty (0 MB) categories stay hidden until non-zero. */
function visibleCategories(disk: StorageMetrics): StorageCategoryMetric[] {
  return (disk.categories ?? []).filter((c) => c.megabytes > 0);
}

/** Restricted categories whose readable lower bound is currently 0 MB. */
function hiddenRestrictedCategories(disk: StorageMetrics): StorageCategoryMetric[] {
  return (disk.categories ?? []).filter((c) => c.megabytes <= 0 && c.restricted === true);
}

/** Compute segment bar percentages so tiny slivers stay visible without eating into free space. */
function segmentWidths(segments: StorageCategoryMetric[], total: number): number[] {
  if (total <= 0 || segments.length === 0) return segments.map(() => 0);
  const raw = segments.map((c) => Math.max(0, (c.megabytes / total) * 100));
  const floors = segments.map((c, idx) => (c.restricted ? 0.5 : raw[idx] > 0 ? 0.8 : 0));
  const widths = raw.map((pct, idx) => Math.max(pct, floors[idx]));
  const extra = widths.reduce((sum, w, idx) => sum + Math.max(0, w - raw[idx]), 0);
  if (extra > 0) {
    const slacks = widths.map((w, idx) => Math.max(0, w - floors[idx]));
    const totalSlack = slacks.reduce((sum, s) => sum + s, 0);
    if (totalSlack > 0) {
      const ratio = Math.min(extra, totalSlack) / totalSlack;
      for (let i = 0; i < widths.length; i++) {
        widths[i] -= slacks[i] * ratio;
      }
    }
  }
  const sum = widths.reduce((acc, w) => acc + w, 0);
  if (sum > 100) {
    const scale = 100 / sum;
    for (let i = 0; i < widths.length; i++) widths[i] *= scale;
  }
  return widths;
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

/** Apple-style segmented usage bar; unknown categories fall back to a neutral gray. */
function CategoryBar({ disk }: { disk: StorageMetrics }) {
  const { t } = useTranslation("hardware");
  const segments = visibleCategories(disk);
  const widths = segmentWidths(segments, disk.total);
  const usedPct = widths.reduce((acc, w) => acc + w, 0);
  return (
    <div
      className="sp-storage-bar"
      role="img"
      aria-label={t("storage.categories.ariaLabel", { label: disk.label })}
    >
      {segments.map((c, idx) => {
        const label = categoryLabel(t, c.id);
        const size = formatGb(c.megabytes);
        return (
          <div
            key={c.id}
            className={`sp-storage-bar__seg sp-storage-bar__seg--${categoryClass(c.id)}${c.restricted ? " is-restricted" : ""}`}
            style={{ ["--seg-pct" as string]: `${widths[idx]}%` }}
            title={c.restricted
              ? `${label}: ${size} — ${t("storage.categories.restricted")}`
              : `${label}: ${size}`}
          />
        );
      })}
      {usedPct < 99.99 && (
        <div className="sp-storage-bar__free" style={{ ["--seg-pct" as string]: `${100 - usedPct}%` }} />
      )}
    </div>
  );
}

function CategoryLegend({ disk }: { disk: StorageMetrics }) {
  const { t } = useTranslation("hardware");
  const segments = visibleCategories(disk);
  const hiddenRestricted = hiddenRestrictedCategories(disk);
  if (segments.length === 0 && hiddenRestricted.length === 0) return null;
  return (
    <div className="sp-storage-legend">
      {segments.map((c) => (
        <span
          key={c.id}
          className="sp-storage-legend__item"
          title={c.restricted ? t("storage.categories.restricted") : undefined}
        >
          <span className={`sp-storage-legend__dot sp-storage-bar__seg--${categoryClass(c.id)}`} />
          <span className="sp-clip">
            {categoryLabel(t, c.id)}
            {c.restricted ? "*" : ""}
          </span>
          <span className="sp-storage-legend__size">{formatGb(c.megabytes)}</span>
        </span>
      ))}
      {hiddenRestricted.length > 0 && (
        <span
          className="sp-storage-legend__item sp-storage-legend__restricted"
          title={`${hiddenRestricted.map((c) => categoryLabel(t, c.id)).join(", ")} — ${t("storage.categories.restricted")}`}
        >
          <span className="sp-storage-legend__dot is-restricted" />
          <span className="sp-clip">
            {t("storage.categories.restrictedHidden", { count: hiddenRestricted.length })}
          </span>
        </span>
      )}
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
                const categories =
                  visibleCategories(disk).length > 0 || hiddenRestrictedCategories(disk).length > 0;
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
                    {categories ? <CategoryBar disk={disk} /> : <UsageBar value={disk.used} max={disk.total} />}
                    {categories && <CategoryLegend disk={disk} />}
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