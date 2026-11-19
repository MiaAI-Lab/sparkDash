import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HeadlessActionResult, HeadlessMetrics, HeadlessState, HeadlessUnit } from "../../api/types";
import { fetchHeadlessFlags, makeHeadless, refreshSparkMetric, restoreDesktop } from "../../api/client";
import { Panel } from "../ui/Panel";
import { Tag, type TagTone } from "../ui/Tag";
import { MemoryIcon } from "../ui/icons";

interface HeadlessPanelProps {
  sparkId: string;
  sparkName: string;
  headless: HeadlessMetrics | null;
  className?: string;
}

const STATE_TONE: Record<HeadlessState, TagTone> = {
  desktop: "neutral",
  headless: "good",
  mixed: "warn",
  unknown: "neutral",
};

function mib(n: number): string {
  return `${n.toLocaleString("en-US")} MiB`;
}

/**
 * Whether this unit boots to a graphical desktop, what the desktop session
 * holds in memory, and the optional desktop services that are on. The two
 * actions stop the desktop or restore it from the record the make action
 * wrote; both run as root through sudo.
 */
export function HeadlessPanel({ sparkId, sparkName, headless, className }: HeadlessPanelProps) {
  const { t } = useTranslation("hardware");
  const [password, setPassword] = useState("");
  const [passwordAllowed, setPasswordAllowed] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<"make" | "restore" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);

  useEffect(() => {
    let live = true;
    fetchHeadlessFlags(sparkId)
      .then((flags) => {
        if (live) setPasswordAllowed(flags.passwordAllowed);
      })
      .catch(() => {
        if (live) setPasswordAllowed(null);
      });
    return () => {
      live = false;
    };
  }, [sparkId]);

  const state: HeadlessState = headless?.available ? headless.state : "unknown";
  const present = headless?.units.filter((u) => u.present === true) ?? [];
  const desktop = headless?.desktop ?? null;

  const stateText = (s: HeadlessState): string => {
    switch (s) {
      case "desktop":
        return t("headless.desktop");
      case "headless":
        return t("headless.headless");
      case "mixed":
        return t("headless.mixed");
      default:
        return t("headless.unknown");
    }
  };

  /** A unit as a row value; null when systemd could not be asked. */
  const unitText = (u: HeadlessUnit): string | null => {
    if (u.present == null) return null;
    if (!u.present) return t("headless.notInstalled");
    if (u.state === "active") {
      if (u.enabled === true) return t("headless.unitOn");
      if (u.enabled === false) return t("headless.unitOnDisabled");
      return t("headless.unitOnUnknown");
    }
    if (u.state === "inactive") {
      if (u.enabled === true) return t("headless.unitOffEnabled");
      if (u.enabled === false) return t("headless.unitOff");
      return t("headless.unitOffUnknown");
    }
    if (u.state === "failed") return t("headless.unitFailed");
    return u.state ?? t("headless.unknown");
  };

  const describe = (kind: "make" | "restore", r: HeadlessActionResult): string[] => {
    const lines: string[] = [];
    const before = r.memBeforeKib != null ? mib(Math.round(r.memBeforeKib / 1024)) : null;
    const after = r.memAfterKib != null ? mib(Math.round(r.memAfterKib / 1024)) : null;
    if (kind === "make") {
      if (before != null && after != null) {
        lines.push(t("headless.madeHeadless", { before, after }));
      } else {
        lines.push(t("headless.madeHeadlessNoMemory"));
      }
      if (r.disabled.length > 0) lines.push(t("headless.disabledUnits", { units: r.disabled.join(", ") }));
      if (r.failed.length > 0) lines.push(t("headless.failedUnits", { units: r.failed.join(", ") }));
      return lines;
    }
    if (r.failed.length > 0) {
      lines.push(t("headless.restoreFailed"));
    } else if (r.defaultAfter !== "graphical.target") {
      lines.push(t("headless.restoreDefaultNotGraphical", { target: r.defaultAfter ?? t("headless.unknown") }));
    } else if (r.mode === "default-only") {
      lines.push(t("headless.restoredDefaultOnly"));
    } else if (before != null && after != null) {
      lines.push(t("headless.restoredDesktop", { before, after }));
    } else {
      lines.push(t("headless.restoredDesktopNoMemory"));
    }
    if (r.defaultAfter && r.defaultAfter !== "graphical.target") {
      lines.push(t("headless.bootDefaultAfter", { target: r.defaultAfter }));
    }
    if (r.restored.length > 0) lines.push(t("headless.restoredUnits", { units: r.restored.join(", ") }));
    if (r.failed.length > 0) lines.push(t("headless.failedUnits", { units: r.failed.join(", ") }));
    return lines;
  };

  const run = async (kind: "make" | "restore") => {
    const confirmText =
      kind === "make"
        ? t("headless.makeConfirm", { name: sparkName })
        : t("headless.restoreConfirm", { name: sparkName });
    if (!window.confirm(confirmText)) return;
    setBusy(kind);
    setResult(null);
    try {
      const res =
        kind === "make"
          ? await makeHeadless(sparkId, selected, password || undefined)
          : await restoreDesktop(sparkId, password || undefined);
      // A restore only succeeded when every step worked and the boot default
      // is back to graphical.target; a failed unit or a default left on
      // multi-user.target means the desktop does not come back at boot.
      const ok =
        res.result.failed.length === 0 &&
        (kind === "make" || res.result.defaultAfter === "graphical.target");
      setResult({ ok, lines: describe(kind, res.result) });
      setPassword("");
      await refreshSparkMetric(sparkId, "headless").catch(() => {});
    } catch (err) {
      setResult({
        ok: false,
        lines: [t("headless.actionFailed", { error: err instanceof Error ? err.message : String(err) })],
      });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (unit: string) => {
    setSelected((current) =>
      current.includes(unit) ? current.filter((u) => u !== unit) : [...current, unit]
    );
  };

  return (
    <Panel
      title={t("headless.title")}
      hint={t("headless.hint")}
      accent={state === "mixed"}
      icon={<MemoryIcon />}
      className={className}
      bodyClassName="sp-stack"
      actions={<Tag tone={STATE_TONE[state]}>{stateText(state)}</Tag>}
    >
      {state === "mixed" && <p className="sp-callout">{t("headless.mixedNote")}</p>}
      {headless && !headless.available && headless.error && (
        <p className="sp-callout">{headless.error}</p>
      )}
      {headless?.available && state === "unknown" && <p className="sp-callout">{t("headless.unknownNote")}</p>}

      <div className="sp-list">
        {headless?.defaultTarget && (
          <Row label={t("headless.bootDefault")} value={headless.defaultTarget} tabular />
        )}
        {headless && unitText(headless.displayManager) && (
          <Row label={t("headless.displayManager")} value={unitText(headless.displayManager) ?? ""} />
        )}
        {desktop && desktop.rssMib != null && (
          <Row
            label={t("headless.desktopMemory")}
            value={
              desktop.swapMib != null
                ? t("headless.memory", { rss: mib(desktop.rssMib), swap: mib(desktop.swapMib) })
                : t("headless.memoryNoSwap", { rss: mib(desktop.rssMib) })
            }
            tabular
          />
        )}
        {desktop?.processes.map((p, index) => (
          <Row
            key={`${p.name}-${index}`}
            label={p.name}
            value={
              p.swapMib
                ? t("headless.processMemory", { rss: mib(p.rssMib), swap: mib(p.swapMib) })
                : mib(p.rssMib)
            }
            tabular
          />
        ))}
        {present.map((u) => (
          <Row key={u.unit} label={u.unit} value={unitText(u) ?? t("headless.unknown")} />
        ))}
        {!headless && <p className="sp-muted">{t("headless.waiting")}</p>}
      </div>

      <div className="sp-section">
        <div className="sp-section__head">
          <span className="sp-lbl">{t("headless.actions")}</span>
        </div>
        {passwordAllowed === true && (
          <label className="sp-field">
            <span className="sp-lbl sp-lbl--sub">{t("headless.sudoPassword")}</span>
            <input
              className="sp-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
            <span className="sp-hint">{t("headless.passwordHint")}</span>
          </label>
        )}
        {passwordAllowed === false && <p className="sp-hint">{t("headless.passwordUnavailable")}</p>}
        {present.length > 0 && (
          <details>
            <summary className="sp-hint">{t("headless.optionalServices")}</summary>
            <div className="sp-stack sp-stack--tight">
              {present.map((u) => (
                <label className="sp-check" key={u.unit}>
                  <input
                    type="checkbox"
                    checked={selected.includes(u.unit)}
                    onChange={() => toggle(u.unit)}
                  />
                  <span>{u.unit}</span>
                </label>
              ))}
            </div>
          </details>
        )}
        <div className="sp-field-row">
          <button
            className="btn btn--sm btn--primary"
            onClick={() => void run("make")}
            disabled={busy != null || state === "headless"}
          >
            {busy === "make" ? t("headless.working") : t("headless.make")}
          </button>
          <button
            className="btn btn--sm"
            onClick={() => void run("restore")}
            disabled={busy != null || state === "desktop"}
          >
            {busy === "restore" ? t("headless.working") : t("headless.restore")}
          </button>
        </div>
        {result && (
          <div className={`sp-callout ${result.ok ? "" : "sp-callout--bad"}`}>
            {result.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Row({
  label,
  value,
  tabular,
}: {
  label: string;
  value: string;
  tabular?: boolean;
}) {
  return (
    <div className="sp-list-row">
      <span className="sp-muted">{label}</span>
      <span className={`sp-clip ${tabular ? "mono" : ""} text-text`}>{value}</span>
    </div>
  );
}
