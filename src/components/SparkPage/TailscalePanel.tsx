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
  const { t } = useTranslation("hardware");
  const online = tailscale?.online ?? null;
  const health = tailscale?.health ?? [];
  const available = Boolean(tailscale?.available);
  const offTailnet = available && online === false;

  const status: { label: string; tone: "neutral" | "good" | "bad" } = !available
    ? { label: t("tailscale.unknown"), tone: "neutral" }
    : online === true
      ? { label: t("tailscale.online"), tone: "good" }
      : online === false
        ? { label: t("tailscale.off"), tone: "bad" }
        : { label: t("tailscale.unknown"), tone: "neutral" };

  return (
    <Panel
      title="Tailnet"
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
        {tailscale?.tailscaleIp && <Row label="IP" value={tailscale.tailscaleIp} tabular />}
        {tailscale?.hostName && <Row label={t("tailscale.host")} value={tailscale.hostName} />}
        {tailscale?.relay && <Row label={t("tailscale.relay")} value={tailscale.relay} />}
        {tailscale?.keyExpired && <Row label={t("tailscale.key")} value={t("tailscale.expired")} danger />}
        {tailscale?.version && <Row label={t("tailscale.version")} value={tailscale.version} tabular />}
        {!available && !tailscale?.error && (
          <p className="sp-muted">{t("tailscale.waiting")}</p>
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
