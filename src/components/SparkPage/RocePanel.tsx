import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RoceDevice, RoceMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { NetworkIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { formatBytesPerSec } from "../../shared/formatBytes";

/** Counters worth showing, in this order; the rest stay in the API. */
export const ROCE_COUNTER_ROWS: { key: string; label: string; loss?: boolean }[] = [
  { key: "out_of_buffer", label: "Out of buffer", loss: true },
  { key: "packet_seq_err", label: "Packet sequence errors", loss: true },
  { key: "local_ack_timeout_err", label: "Local ACK timeouts", loss: true },
  { key: "rnr_nak_retry_err", label: "RNR NAK retries", loss: true },
  { key: "implied_nak_seq_err", label: "Implied NAK errors", loss: true },
  { key: "req_transport_retries_exceeded", label: "Transport retries exceeded", loss: true },
  { key: "rx_icrc_encapsulated", label: "ICRC errors", loss: true },
  { key: "np_ecn_marked_roce_packets", label: "ECN-marked packets" },
  { key: "np_cnp_sent", label: "CNPs sent" },
  { key: "rp_cnp_handled", label: "CNPs handled" },
  { key: "roce_adp_retrans", label: "Adaptive retransmits" },
  { key: "duplicate_request", label: "Duplicate requests" },
];

const ETH_ROWS: { key: string; label: string }[] = [
  { key: "rx_discards_phy", label: "RX discards" },
  { key: "tx_discards_phy", label: "TX discards" },
  { key: "rx_crc_errors_phy", label: "CRC errors" },
  { key: "rx_pause_ctrl_phy", label: "Pause frames received" },
  { key: "tx_pause_ctrl_phy", label: "Pause frames sent" },
];

function counterLabel(t: TFunction, key: string, fallback: string): string {
  switch (key) {
    case "out_of_buffer":
      return t("spark.roce.counter.outOfBuffer", "Out of buffer");
    case "packet_seq_err":
      return t("spark.roce.counter.packetSeqErr", "Packet sequence errors");
    case "local_ack_timeout_err":
      return t("spark.roce.counter.localAckTimeoutErr", "Local ACK timeouts");
    case "rnr_nak_retry_err":
      return t("spark.roce.counter.rnrNakRetryErr", "RNR NAK retries");
    case "implied_nak_seq_err":
      return t("spark.roce.counter.impliedNakSeqErr", "Implied NAK errors");
    case "req_transport_retries_exceeded":
      return t("spark.roce.counter.reqTransportRetriesExceeded", "Transport retries exceeded");
    case "rx_icrc_encapsulated":
      return t("spark.roce.counter.rxIcrcEncapsulated", "ICRC errors");
    case "np_ecn_marked_roce_packets":
      return t("spark.roce.counter.npEcnMarkedRocePackets", "ECN-marked packets");
    case "np_cnp_sent":
      return t("spark.roce.counter.npCnpSent", "CNPs sent");
    case "rp_cnp_handled":
      return t("spark.roce.counter.rpCnpHandled", "CNPs handled");
    case "roce_adp_retrans":
      return t("spark.roce.counter.roceAdpRetrans", "Adaptive retransmits");
    case "duplicate_request":
      return t("spark.roce.counter.duplicateRequest", "Duplicate requests");
    case "rx_discards_phy":
      return t("spark.roce.counter.rxDiscardsPhy", "RX discards");
    case "tx_discards_phy":
      return t("spark.roce.counter.txDiscardsPhy", "TX discards");
    case "rx_crc_errors_phy":
      return t("spark.roce.counter.rxCrcErrorsPhy", "CRC errors");
    case "rx_pause_ctrl_phy":
      return t("spark.roce.counter.rxPauseCtrlPhy", "Pause frames received");
    case "tx_pause_ctrl_phy":
      return t("spark.roce.counter.txPauseCtrlPhy", "Pause frames sent");
    default:
      return fallback;
  }
}

const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());

/** "PFC on: 3" / "PFC off" / null when unknown. */
export function pfcLabel(d: RoceDevice, t?: TFunction): { text: string; tone: "good" | "neutral" | "warn" } | null {
  const p = d.qos?.pfcPriorities;
  if (p == null) return null;
  if (p.length > 0) {
    const list = p.join(", ");
    return {
      text: t ? t("spark.roce.pfcOn", "PFC on: {priorities}", { priorities: list }) : `PFC on: ${list}`,
      tone: "good",
    };
  }
  return {
    text: t ? t("spark.roce.pfcOff", "PFC off") : "PFC off",
    tone: "neutral",
  };
}

function linkTone(d: RoceDevice): "good" | "warn" | "bad" | "neutral" {
  if (d.active) return "good";
  return d.everActive ? "bad" : "neutral";
}

function PortRow({ d }: { d: RoceDevice }) {
  const { t } = useTranslation();
  const pfc = pfcLabel(d, t);
  const lossRising = d.loss.rising.length > 0;
  const speed = d.speedMbps != null ? `${d.speedMbps / 1000} Gb/s` : d.rateGbps != null ? `${d.rateGbps} Gb/s` : null;
  const dscp = d.qos?.dscpMap
    ? Object.entries(d.qos.dscpMap)
        .map(([prio, list]) => `prio ${prio}: DSCP ${list.join(",")}`)
        .join(" · ")
    : null;
  return (
    <div className={`sp-roce-port ${d.active ? "" : "is-down"}`} data-testid={`roce-${d.name}`}>
      <div className="sp-roce-port__head">
        <span className="mono sp-clip" title={d.name}>{d.netdev ?? d.name}</span>
        <span className="sp-chips">
          <Tag tone={linkTone(d)} title={d.physState ?? undefined}>{d.state ?? t("spark.roce.stateUnknown", "unknown")}</Tag>
          {speed && <Tag>{speed}</Tag>}
          {d.mtu != null && <Tag title={t("spark.roce.mtuTitle", "MTU")}>MTU {d.mtu}</Tag>}
        </span>
      </div>
      <div className="sp-roce-port__rates mono">
        <span><span className="text-accent">↓</span> {d.rxBps == null ? "—" : formatBytesPerSec(Math.round(d.rxBps))}</span>
        <span><span className="text-accent">↑</span> {d.txBps == null ? "—" : formatBytesPerSec(Math.round(d.txBps))}</span>
        <span title={t("spark.roce.dropsTitle", "Frames dropped or in error on this interface")}>
          {t("spark.roce.errDrop", "{errors} err · {drops} drop", { errors: n(d.rxErrors), drops: n(d.rxDropped) })}
        </span>
      </div>
      <div className="sp-chips sp-roce-port__qos">
        {pfc && <Tag tone={pfc.tone} title={t("spark.roce.pfcTitle", "Priority flow control (mlnx_qos)")}>{pfc.text}</Tag>}
        {d.qos?.trust && <Tag title={t("spark.roce.trustTitle", "QoS trust mode")}>{t("spark.roce.trustTag", "trust {mode}", { mode: d.qos.trust })}</Tag>}
        {d.flowControl && (d.flowControl.rx || d.flowControl.tx) && (
          <Tag title={t("spark.roce.pauseTitle", "Global pause (ethtool -a)")}>pause {d.flowControl.rx ? "rx" : ""}{d.flowControl.rx && d.flowControl.tx ? "/" : ""}{d.flowControl.tx ? "tx" : ""}</Tag>
        )}
        {lossRising && <Tag tone="warn" title={d.loss.rising.join(", ")}>{t("spark.roce.lossRising", "loss rising")}</Tag>}
      </div>
      {dscp && <div className="sp-muted mono sp-roce-port__dscp">{dscp}</div>}
      <details className="sp-roce-port__more">
        <summary>{t("spark.roce.counters", "RDMA counters")}</summary>
        <table className="sp-roce-table">
          <tbody>
            {ROCE_COUNTER_ROWS.filter((r) => d.counters[r.key] != null).map((r) => {
              const delta = d.deltas[r.key] ?? 0;
              return (
                <tr key={r.key} className={r.loss && delta > 0 ? "is-rising" : ""}>
                  <td>{counterLabel(t, r.key, r.label)}</td>
                  <td className="mono">{n(d.counters[r.key])}</td>
                  <td className="mono sp-muted">{delta > 0 ? `+${delta.toLocaleString()}` : ""}</td>
                </tr>
              );
            })}
            {d.eth &&
              ETH_ROWS.filter((r) => d.eth![r.key] != null).map((r) => (
                <tr key={r.key}>
                  <td>{counterLabel(t, r.key, r.label)}</td>
                  <td className="mono">{n(d.eth![r.key])}</td>
                  <td />
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const OPEN_KEY = "sparkdash.roce.open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** One line for the collapsed panel: link count, speeds, PFC, and whether loss is rising. */
export function roceSummary(devices: RoceDevice[], t?: TFunction): { text: string; tone: "good" | "warn" | "bad" | "neutral" } {
  const up = devices.filter((d) => d.active);
  const down = devices.filter((d) => d.everActive && !d.active);
  const lossy = devices.filter((d) => d.loss.rising.length > 0);
  const speeds = [...new Set(up.map((d) => d.speedMbps ?? (d.rateGbps != null ? d.rateGbps * 1000 : null)).filter((v): v is number => v != null))];
  const pfcKnown = devices.filter((d) => d.qos?.pfcPriorities != null);
  const pfcOn = pfcKnown.filter((d) => (d.qos?.pfcPriorities?.length ?? 0) > 0).length;
  const parts = [
    t
      ? t("spark.roce.summaryUp", "{up}/{total} up", { up: up.length, total: devices.length })
      : `${up.length}/${devices.length} up`,
    speeds.length > 0 ? speeds.map((v) => `${v / 1000} Gb/s`).join(" / ") : null,
    pfcKnown.length > 0
      ? pfcOn === 0
        ? t ? t("spark.roce.pfcOff", "PFC off") : "PFC off"
        : t
          ? t("spark.roce.summaryPfcOn", "PFC on ({pfcOn}/{total})", { pfcOn, total: pfcKnown.length })
          : `PFC on (${pfcOn}/${pfcKnown.length})`
      : null,
    lossy.length > 0
      ? t ? t("spark.roce.lossRising", "loss rising") : "loss rising"
      : down.length > 0
        ? t ? t("spark.roce.summaryDown", "{down} down", { down: down.length }) : `${down.length} down`
        : t ? t("spark.roce.noLoss", "no loss") : "no loss",
  ].filter(Boolean);
  return { text: parts.join(" · "), tone: down.length > 0 ? "bad" : lossy.length > 0 ? "warn" : up.length === devices.length ? "good" : "neutral" };
}

/** RoCE / RDMA ports of a unit (shown only when it has RDMA devices). Collapsed by default. */
export function RocePanel({ roce, className }: { roce: RoceMetrics | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(readOpen);
  if (!roce || roce.devices.length === 0) return null;
  // Ports that never came up are not noise worth a row, but keep them reachable.
  const live = roce.devices.filter((d) => d.active || d.everActive);
  const idle = roce.devices.filter((d) => !d.active && !d.everActive);
  const summary = roceSummary(roce.devices, t);
  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? "0" : "1");
      } catch {
        /* storage may be blocked */
      }
      return !v;
    });
  };
  return (
    <Panel
      title={t("spark.roce.title", "RoCE / RDMA")}
      accent
      icon={<NetworkIcon />}
      className={`panel-roce ${className ?? ""}`}
      bodyClassName="sp-stack"
      hint={t(
        "spark.roce.hint",
        "Link state, rate, traffic, drops and RDMA counters per port, read from sysfs, ethtool and mlnx_qos on the Spark itself.",
      )}
      actions={
        <button
          type="button"
          className={`btn btn--sm btn--ghost ${open ? "is-on" : ""}`}
          aria-expanded={open}
          aria-controls="roce-ports"
          onClick={toggle}
        >
          {open ? t("spark.roce.hidePorts", "Hide ports") : t("spark.roce.showPorts", "Show ports")}
        </button>
      }
    >
      <div className="sp-roce-summary">
        <Tag tone={summary.tone}>{summary.text}</Tag>
      </div>
      {open && (
        <div id="roce-ports" className="sp-stack">
          {live.map((d) => (
            <PortRow key={d.name} d={d} />
          ))}
          {idle.length > 0 && (
            <p className="sp-muted sp-roce-idle">
              {t(
                "spark.roce.idlePorts",
                "{count, plural, one {# port not connected} other {# ports not connected}}: {ports}",
                { count: idle.length, ports: idle.map((d) => d.netdev ?? d.name).join(", ") },
              )}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
