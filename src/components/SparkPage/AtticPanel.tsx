import { useTranslation } from "react-i18next";
import type { AtticMetrics, AtticState, AtticUnit } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag, type TagTone } from "../ui/Tag";
import { MemoryIcon } from "../ui/icons";

interface AtticPanelProps {
  attic: AtticMetrics | null;
  className?: string;
}

const STATE_TONE: Record<AtticState, TagTone> = {
  lending: "good",
  refusing: "warn",
  unvalidated: "warn",
  off: "neutral",
  "not installed": "neutral",
  unknown: "neutral",
};

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function mib(n: number): string {
  return `${count(n)} MiB`;
}

/**
 * What spark-attic does with this GB10's display carveout: not installed,
 * off, refusing (and why), waiting for its driver to be validated, or lending
 * N of the carveout's MiB. Numbers come only from a fresh status file: a stale
 * or unreadable one reads as unknown, never as atticd lending.
 */
export function AtticPanel({ attic, className }: AtticPanelProps) {
  const { t } = useTranslation("hardware");
  const state: AtticState = attic?.available ? attic.state : "unknown";
  const a = attic?.attic ?? null;
  const fresh = a != null && (a.status === "ready" || a.status === "refusing");
  const stale = a?.status === "stale";

  const stateText = (s: AtticState): string => {
    switch (s) {
      case "lending":
        return t("attic.lending");
      case "refusing":
        return t("attic.refusing");
      case "unvalidated":
        return t("attic.unvalidated");
      case "off":
        return t("attic.off");
      case "not installed":
        return t("attic.notInstalled");
      default:
        return t("attic.unknown");
    }
  };

  /** attic.service as a row value; null when systemd could not be asked. */
  const unitText = (u: AtticUnit): string | null => {
    if (u.present == null) return null;
    if (!u.present) return t("attic.notInstalled");
    if (u.state === "active") return t("attic.running");
    if (u.state === "inactive") return t("attic.stopped");
    if (u.state === "failed") return t("attic.failed");
    return u.state ?? t("attic.unknown");
  };

  /** The one sentence that explains the state, when the rows alone do not. */
  const explain = (): { text: string; bad: boolean } | null => {
    if (!attic) return null;
    if (!attic.available) return attic.error ? { text: attic.error, bad: false } : null;
    if (state === "refusing") return { text: a?.why ?? t("attic.refusedNoReason"), bad: false };
    if (state === "unvalidated") {
      const driver = a?.driver ?? "?";
      return {
        text: a?.mode
          ? t("attic.validateDriver", { driver, mode: a.mode })
          : t("attic.validateDriverNoMode", { driver }),
        bad: false,
      };
    }
    if (state !== "unknown") return null;
    if (stale) return { text: t("attic.stale", { age: a.ageS, every: a.everyS }), bad: true };
    if (a?.status === "unreadable") return { text: a.why ?? t("attic.unclear"), bad: true };
    if (a) return { text: t("attic.unclear"), bad: false };
    if (attic.atticd.present == null) return { text: t("attic.noSystemd"), bad: false };
    if (attic.atticd.active === true) return { text: t("attic.noFile"), bad: false };
    return { text: t("attic.unitChanging", { state: attic.atticd.state ?? "?" }), bad: false };
  };

  const note = explain();
  const service = attic && !fresh ? unitText(attic.atticd) : null;
  const lending = state === "lending" && a != null;

  return (
    <Panel
      title={t("attic.title")}
      hint={t("attic.hint")}
      accent={state === "unknown" && stale}
      icon={<MemoryIcon />}
      className={className}
      bodyClassName="sp-stack"
      actions={
        <Tag tone={state === "unknown" && (stale || a?.status === "unreadable") ? "bad" : STATE_TONE[state]}>
          {stateText(state)}
        </Tag>
      }
    >
      {note && <p className={`sp-callout ${note.bad ? "sp-callout--bad" : ""}`}>{note.text}</p>}

      <div className="sp-list">
        {lending && a.lentMib != null && a.sizeMib != null && (
          <Row
            label={t("attic.lent")}
            value={
              t("attic.lentOf", { lent: count(a.lentMib), size: mib(a.sizeMib) }) +
              (a.drainingMib ? ` ${t("attic.returning", { mib: mib(a.drainingMib) })}` : "")
            }
            tabular
          />
        )}
        {lending && a.freeMib != null && <Row label={t("attic.free")} value={mib(a.freeMib)} tabular />}
        {lending && a.largestMib != null && a.largestMib !== a.freeMib && (
          <Row label={t("attic.largest")} value={mib(a.largestMib)} tabular />
        )}
        {lending && a.clients != null && <Row label={t("attic.clients")} value={String(a.clients)} tabular />}
        {fresh && a.mode && <Row label={t("attic.mode")} value={a.mode} />}
        {fresh && a.driver && (
          <Row
            label={t("attic.driver")}
            value={
              a.validated
                ? t("attic.driverValidated", { driver: a.driver })
                : t("attic.driverNotValidated", { driver: a.driver })
            }
            tabular
            danger={a.validated === false}
          />
        )}
        {fresh && a.ageS != null && (
          <Row label={t("attic.updated")} value={t("attic.secondsAgo", { s: Math.max(0, a.ageS) })} tabular />
        )}
        {a?.version && <Row label={t("attic.version")} value={a.version} tabular />}
        {service && <Row label={t("attic.service")} value={service} />}
        {!attic && <p className="sp-muted">{t("attic.waiting")}</p>}
      </div>
    </Panel>
  );
}

function Row({
  label,
  value,
  tabular,
  danger,
}: {
  label: string;
  value: string;
  tabular?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="sp-list-row">
      <span className="sp-muted">{label}</span>
      <span
        className={`sp-clip ${tabular ? "mono" : ""} ${
          danger ? "text-danger" : "text-text"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
