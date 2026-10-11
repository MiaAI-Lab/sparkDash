import { useTranslation } from "react-i18next";
import type { TailscaleMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { NetworkIcon } from "../ui/icons";

interface TailscalePanelProps {
  tailscale: TailscaleMetrics | null;
  className?: string;
}

/**
 * Tailnet presence for one unit. The failure mode is "healthy on the LAN,
 * invisible off it" — every other panel is LAN-fed and looks fine.
 */
export function TailscalePanel({ tailscale, className }: TailscalePanelProps) {
  const { t } = useTranslation();
  const online = tailscale?.online ?? null;
  const health = tailscale?.health ?? [];
  const available = Boolean(tailscale?.available);
  const offTailnet = available && online === false;

  const status: { label: string; tone: "neutral" | "good" | "bad" } = !available
    ? { label: t("spark.tailscale.statusUnknown", "unknown"), tone: "neutral" }
    : online === true
      ? { label: t("spark.tailscale.statusOnline", "online"), tone: "good" }
      : online === false
        ? { label: t("spark.tailscale.statusOff", "OFF TAILNET"), tone: "bad" }
        : { label: t("spark.tailscale.statusUnknown", "unknown"), tone: "neutral" };

  return (
    <Panel
      title={t("spark.tailscale.title", "Tailnet")}
      accent={offTailnet}
      icon={<NetworkIcon />}
      className={className}
      bodyClassName="sp-stack"
      actions={
        <>
          <Tag tone={status.tone}>{status.label}</Tag>
          {tailscale?.backendState && <Tag>{tailscale.backendState}</Tag>}
        </>
      }
    >

      {health.length > 0 && (
        <div className="sp-stack sp-stack--tight">
          {health.map((msg) => (
            <p
              key={msg}
              className="sp-callout sp-callout--bad"
            >
              {msg}
            </p>
          ))}
        </div>
      )}

      {tailscale?.error && (
        <p className="sp-callout">
          {tailscale.error}
        </p>
      )}

      <div className="sp-list">
        {tailscale?.tailscaleIp && (
          <Row label={t("spark.tailscale.ip", "IP")} value={tailscale.tailscaleIp} tabular />
        )}
        {tailscale?.hostName && (
          <Row label={t("spark.tailscale.host", "Host")} value={tailscale.hostName} />
        )}
        {tailscale?.relay && (
          <Row label={t("spark.tailscale.relay", "Relay")} value={tailscale.relay} />
        )}
        {tailscale?.keyExpired && (
          <Row
            label={t("spark.tailscale.key", "Key")}
            value={t("spark.tailscale.keyExpired", "EXPIRED — needs re-auth")}
            danger
          />
        )}
        {tailscale?.version && (
          <Row label={t("spark.tailscale.version", "Version")} value={tailscale.version} tabular />
        )}
        {!available && !tailscale?.error && (
          <p className="sp-muted">{t("spark.tailscale.waiting", "Waiting for first poll…")}</p>
        )}
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
