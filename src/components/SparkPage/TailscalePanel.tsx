import type { TailscaleMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { NetworkIcon } from "../ui/icons";

interface TailscalePanelProps {
  tailscale: TailscaleMetrics | null;
}

/**
 * Tailnet presence for one Spark.
 *
 * The state worth shouting about is "reachable on the LAN but NOT on the
 * tailnet" — every other panel here is fed over the LAN, so they all look
 * healthy while the box is invisible from anywhere else.
 */
export function TailscalePanel({ tailscale }: TailscalePanelProps) {
  const online = tailscale?.online ?? null;
  const health = tailscale?.health ?? [];
  const available = Boolean(tailscale?.available);

  // Unknown (null) is deliberately not treated as a failure — the first poll
  // may not have landed, and tailscale may omit the field.
  const offTailnet = available && online === false;

  const status = !available
    ? { label: "unknown", cls: "text-muted" }
    : online === true
      ? { label: "online", cls: "text-accent" }
      : online === false
        ? { label: "OFF TAILNET", cls: "text-danger" }
        : { label: "unknown", cls: "text-muted" };

  return (
    <Panel title="Tailnet" accent={offTailnet} icon={<NetworkIcon />}>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="text-muted">Status</span>
        <span className={`font-tabular font-medium ${status.cls}`}>{status.label}</span>
        {tailscale?.backendState && (
          <span className="ml-auto chip py-0.5">{tailscale.backendState}</span>
        )}
      </div>

      {/* Tailscale's own explanation of a bad state — the actionable part. */}
      {health.length > 0 && (
        <div className="mb-2 space-y-1">
          {health.map((msg) => (
            <p
              key={msg}
              className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[11px] text-text"
            >
              {msg}
            </p>
          ))}
        </div>
      )}

      {tailscale?.error && (
        <p className="mb-2 rounded-md border border-border bg-surface-elevated px-3 py-2 text-[11px] text-muted">
          {tailscale.error}
        </p>
      )}

      <div className="space-y-2">
        {tailscale?.tailscaleIp && (
          <Row label="IP" value={tailscale.tailscaleIp} tabular />
        )}
        {tailscale?.hostName && <Row label="Host" value={tailscale.hostName} />}
        {tailscale?.relay && <Row label="Relay" value={tailscale.relay} />}
        {tailscale?.keyExpired && <Row label="Key" value="EXPIRED — needs re-auth" danger />}
        {tailscale?.version && <Row label="Version" value={tailscale.version} tabular />}
        {!available && !tailscale?.error && (
          <p className="text-xs text-muted">Waiting for first poll…</p>
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
    <div className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2">
      <span className="text-xs text-muted">{label}</span>
      <span
        className={`truncate text-xs ${tabular ? "font-tabular" : ""} ${
          danger ? "text-danger" : "text-text"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
