import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useState } from "react";
import type { RoceDevice, RoceMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { NetworkIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { formatBytesPerSec } from "../../shared/formatBytes";

/** Counters worth showing, in this order; the rest stay in the API. */
function counterRows(t: TFunction): { key: string; label: string; loss?: boolean }[] { return [
  { key: "out_of_buffer", label: t("roce.counters.buffer"), loss: true },
  { key: "packet_seq_err", label: t("roce.counters.sequence"), loss: true },
  { key: "local_ack_timeout_err", label: t("roce.counters.ack"), loss: true },
  { key: "rnr_nak_retry_err", label: t("roce.counters.rnr"), loss: true },
  { key: "implied_nak_seq_err", label: t("roce.counters.nak"), loss: true },
  { key: "req_transport_retries_exceeded", label: t("roce.counters.retry"), loss: true },
  { key: "rx_icrc_encapsulated", label: t("roce.counters.icrc"), loss: true },
  { key: "np_ecn_marked_roce_packets", label: t("roce.counters.ecn") },
  { key: "np_cnp_sent", label: t("roce.counters.cnpSent") },
  { key: "rp_cnp_handled", label: t("roce.counters.cnpHandled") },
  { key: "roce_adp_retrans", label: t("roce.counters.adaptive") },
  { key: "duplicate_request", label: t("roce.counters.duplicate") },
 ]; }

function ethRows(t: TFunction): { key: string; label: string }[] { return [
  { key: "rx_discards_phy", label: t("roce.counters.rxDiscard") },
  { key: "tx_discards_phy", label: t("roce.counters.txDiscard") },
  { key: "rx_crc_errors_phy", label: t("roce.counters.crc") },
  { key: "rx_pause_ctrl_phy", label: t("roce.counters.pauseReceived") },
  { key: "tx_pause_ctrl_phy", label: t("roce.counters.pauseSent") },
 ]; }

const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());

/** "PFC on: 3" / t("roce.pfcOff") / null when unknown. */
export function pfcLabel(d: RoceDevice, t: TFunction): { text: string; tone: "good" | "neutral" | "warn" } | null {
  const p = d.qos?.pfcPriorities;
  if (p == null) return null;
  return p.length > 0 ? { text: t("roce.pfcOn", { priorities: p.join(", ") }), tone: "good" } : { text: t("roce.pfcOff"), tone: "neutral" };
}

function linkTone(d: RoceDevice): "good" | "warn" | "bad" | "neutral" {
  if (d.active) return "good";
  return d.everActive ? "bad" : "neutral";
}

function PortRow({ d }: { d: RoceDevice }) {
  const { t } = useTranslation("hardware");
  const pfc = pfcLabel(d, t);
  const lossRising = d.loss.rising.length > 0;
  const speed = d.speedMbps != null ? `${d.speedMbps / 1000} Gb/s` : d.rateGbps != null ? `${d.rateGbps} Gb/s` : null;
  const dscp = d.qos?.dscpMap
    ? Object.entries(d.qos.dscpMap)
        .map(([prio, list]) => t("roce.dscp", { priority: prio, values: list.join(",") }))
        .join(" · ")
    : null;
  return (
    <div className={`sp-roce-port ${d.active ? "" : "is-down"}`} data-testid={`roce-${d.name}`}>
      <div className="sp-roce-port__head">
        <span className="mono sp-clip" title={d.name}>{d.netdev ?? d.name}</span>
        <span className="sp-chips">
          <Tag tone={linkTone(d)} title={d.physState ?? undefined}>{d.state ?? t("roce.unknown")}</Tag>
          {speed && <Tag>{speed}</Tag>}
          {d.mtu != null && <Tag title="MTU">MTU {d.mtu}</Tag>}
        </span>
      </div>
      <div className="sp-roce-port__rates mono">
        <span><span className="text-accent">↓</span> {d.rxBps == null ? "—" : formatBytesPerSec(Math.round(d.rxBps))}</span>
        <span><span className="text-accent">↑</span> {d.txBps == null ? "—" : formatBytesPerSec(Math.round(d.txBps))}</span>
        <span title={t("roce.frameHint")}>
          {t("roce.errors", { errors: n(d.rxErrors), dropped: n(d.rxDropped) })}
        </span>
      </div>
      <div className="sp-roce-port__rates mono">
        <span title={t("roce.rxHint")}>
          <span className="text-accent">RDMA ↓</span> {d.rdmaRxBps == null ? "—" : formatBytesPerSec(Math.round(d.rdmaRxBps))}
        </span>
        <span title={t("roce.txHint")}>
          <span className="text-accent">RDMA ↑</span> {d.rdmaTxBps == null ? "—" : formatBytesPerSec(Math.round(d.rdmaTxBps))}
        </span>
      </div>
      <div className="sp-chips sp-roce-port__qos">
        {pfc && <Tag tone={pfc.tone} title={t("roce.pfcHint")}>{pfc.text}</Tag>}
        {d.qos?.trust && <Tag title={t("roce.trustHint")}>{t("roce.trust", { mode: d.qos.trust })}</Tag>}
        {d.flowControl && (d.flowControl.rx || d.flowControl.tx) && (
          <Tag title={t("roce.pauseHint")}>{t("roce.pause")} {d.flowControl.rx ? "rx" : ""}{d.flowControl.rx && d.flowControl.tx ? "/" : ""}{d.flowControl.tx ? "tx" : ""}</Tag>
        )}
        {lossRising && <Tag tone="warn" title={d.loss.rising.join(", ")}>{t("roce.loss")}</Tag>}
      </div>
      {dscp && <div className="sp-muted mono sp-roce-port__dscp">{dscp}</div>}
      <details className="sp-roce-port__more">
        <summary>{t("roce.counterTitle")}</summary>
        <table className="sp-roce-table">
          <tbody>
            {counterRows(t).filter((r) => d.counters[r.key] != null).map((r) => {
              const delta = d.deltas[r.key] ?? 0;
              return (
                <tr key={r.key} className={r.loss && delta > 0 ? "is-rising" : ""}>
                  <td>{r.label}</td>
                  <td className="mono">{n(d.counters[r.key])}</td>
                  <td className="mono sp-muted">{delta > 0 ? `+${delta.toLocaleString()}` : ""}</td>
                </tr>
              );
            })}
            {d.eth &&
              ethRows(t).filter((r) => d.eth![r.key] != null).map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
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
export function roceSummary(devices: RoceDevice[], t: TFunction): { text: string; tone: "good" | "warn" | "bad" | "neutral" } {
  const up = devices.filter((d) => d.active);
  const down = devices.filter((d) => d.everActive && !d.active);
  const lossy = devices.filter((d) => d.loss.rising.length > 0);
  const speeds = [...new Set(up.map((d) => d.speedMbps ?? (d.rateGbps != null ? d.rateGbps * 1000 : null)).filter((v): v is number => v != null))];
  const pfcKnown = devices.filter((d) => d.qos?.pfcPriorities != null);
  const pfcOn = pfcKnown.filter((d) => (d.qos?.pfcPriorities?.length ?? 0) > 0).length;
  const parts = [
    t("roce.up", { up: up.length, total: devices.length }),
    speeds.length > 0 ? speeds.map((v) => `${v / 1000} Gb/s`).join(" / ") : null,
    pfcKnown.length > 0 ? (pfcOn === 0 ? t("roce.pfcOff") : t("roce.pfcSummary", { on: pfcOn, total: pfcKnown.length })) : null,
    lossy.length > 0 ? t("roce.loss") : down.length > 0 ? t("roce.down", { count: down.length }) : t("roce.noLoss"),
  ].filter(Boolean);
  return { text: parts.join(" · "), tone: down.length > 0 ? "bad" : lossy.length > 0 ? "warn" : up.length === devices.length ? "good" : "neutral" };
}

/** RoCE / RDMA ports of a unit (shown only when it has RDMA devices). Collapsed by default. */
export function RocePanel({ roce, className }: { roce: RoceMetrics | null | undefined; className?: string }) {
  const { t } = useTranslation("hardware");
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
      title="RoCE / RDMA"
      accent
      icon={<NetworkIcon />}
      className={`panel-roce ${className ?? ""}`}
      bodyClassName="sp-stack"
      hint={t("roce.hint")}
      actions={
        <button
          type="button"
          className={`btn btn--sm btn--ghost ${open ? "is-on" : ""}`}
          aria-expanded={open}
          aria-controls="roce-ports"
          onClick={toggle}
        >
          {open ? t("roce.hide") : t("roce.show")}
        </button>
      }
    >
      <div className="sp-roce-summary">
        <Tag tone={summary.tone}>{summary.text}</Tag>
      </div>
      <p className="sp-muted">{t("roce.trafficHelp")}</p>
      {open && (
        <div id="roce-ports" className="sp-stack">
          {live.map((d) => (
            <PortRow key={d.name} d={d} />
          ))}
          {idle.length > 0 && (
            <p className="sp-muted sp-roce-idle">
              {t("roce.disconnected", { count: idle.length, names: idle.map((d) => d.netdev ?? d.name).join(", ") })}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
