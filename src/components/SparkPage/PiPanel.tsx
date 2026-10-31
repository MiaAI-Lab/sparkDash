import type { HardwareInfo, PiStatus } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { CpuIcon } from "../ui/icons";

interface PiPanelProps {
  pi: PiStatus | null;
  hardware: HardwareInfo;
  className?: string;
}

/**
 * Raspberry Pi board panel: model/revision and the firmware throttle state.
 * CPU temperature lives in CpuPanel; this panel answers "what board is this and
 * is its power/thermal envelope healthy?" without inventing GPU or power data.
 */
export function PiPanel({ pi, hardware, className }: PiPanelProps) {
  const throttle = pi?.throttle ?? null;
  const unavailable = Boolean(pi) && !pi?.throttleAvailable;
  const active: string[] = [];
  const occurred: string[] = [];
  if (throttle?.underVoltage) active.push("under-voltage");
  if (throttle?.freqCapped) active.push("frequency capped");
  if (throttle?.throttled) active.push("throttling");
  if (throttle?.softTempLimit) active.push("soft temperature limit");
  if (throttle?.underVoltageOccurred && !throttle.underVoltage) occurred.push("under-voltage");
  if (throttle?.freqCappedOccurred && !throttle.freqCapped) occurred.push("frequency cap");
  if (throttle?.throttledOccurred && !throttle.throttled) occurred.push("throttling");
  if (throttle?.softTempLimitOccurred && !throttle.softTempLimit) occurred.push("soft temperature limit");

  return (
    <Panel
      title="Raspberry Pi"
      icon={<CpuIcon />}
      className={`panel-pi ${className ?? ""}`}
      bodyClassName="sp-stack"
      hint="Firmware state from vcgencmd. This board has no supported GPU and no measured input power."
    >
      <div className="sp-row">
        <span className="text-muted">Board</span>
        <span className="mono sp-clip text-text" title={hardware.device}>
          {hardware.device}
        </span>
      </div>
      <div className="sp-row">
        <span className="text-muted">Revision</span>
        <span className="mono text-text">{pi?.revision ?? "—"}</span>
      </div>
      <div className="sp-row sp-row--rule">
        <span className="text-muted">Firmware</span>
        <span className="text-text">
          {!pi ? (
            "Waiting for board status…"
          ) : unavailable ? (
            <span title="vcgencmd could not read the firmware state; grant the SSH user video/GPIO access or add a read-only sudoers rule.">
              throttle state unavailable
            </span>
          ) : active.length > 0 || occurred.length > 0 ? (
            <span className="inline-flex flex-wrap gap-1">
              {active.map((label) => (
                <Tag key={label} tone="bad">{label}</Tag>
              ))}
              {occurred.map((label) => (
                <Tag key={`occurred-${label}`} tone="warn" title="Occurred since boot; not active now">
                  {label} earlier
                </Tag>
              ))}
            </span>
          ) : (
            <Tag tone="good">nominal</Tag>
          )}
        </span>
      </div>
      {pi?.serial ? (
        <div className="sp-row">
          <span className="text-muted">Serial</span>
          <span className="mono sp-clip text-text" title={pi.serial}>{pi.serial}</span>
        </div>
      ) : null}
    </Panel>
  );
}
