import type { CpuMetrics, HardwareInfo } from "../../api/types";
import { useTranslation } from "react-i18next";
import { TrendLine } from "../ui/TrendLine";
import { Panel } from "../ui/Panel";
import { CpuIcon } from "../ui/icons";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface CpuPanelProps {
  cpu: CpuMetrics | null;
  hardware?: HardwareInfo | null;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
  className?: string;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/**
 * CPU panel — usage, temperature, and power for the SoC CPU.
 *
 * On GB10 devices (DGX Spark / GX10) the CPU and GPU share one package and
 * one power envelope, so the CPU is often the part that runs hot first —
 * this panel makes that visible at the device level. For non-Spark GPU
 * hosts it covers the discrete CPU.
 */
export function CpuPanel({ cpu, hardware, sparkId, temperatureUnit, className }: CpuPanelProps) {
  const { t } = useTranslation("spark");
  const usageHistory = useMetricsHistoryTail(sparkId, "cpu.usage");
  const tempHistory = useMetricsHistoryTail(sparkId, "cpu.temp");

  const usage = cpu?.usage ?? 0;
  const temperature = cpu?.temperature ?? 0;
  const draw = cpu?.draw ?? 0;
  const tdp = cpu?.tdp ?? 0;

  // No sensor (Windows exposes none without a driver): show a dash, not 0 °C.
  const hasTemp = temperature > 0 || Boolean(cpu?.temperatureSource);
  const displayTemp = !hasTemp
    ? "—"
    : temperatureUnit === "fahrenheit"
      ? celsiusToFahrenheit(temperature)
      : temperature;

  // GB10 SoC bands: the CPU complex derates in the mid-80s; x86 hosts run
  // hotter before throttling, so the danger band sits higher.
  const tempColor =
    temperature > 95
      ? "var(--color-danger)"
      : temperature > 85
        ? "var(--color-warning)"
        : "var(--color-accent)";

  const model = hardware?.cpuModel;
  const cores = hardware?.cpuCores;
  const socPackage = cpu?.temperatureSource === "acpitz";

  return (
    <Panel
      title="CPU"
      hint={
        socPackage
          ? t("cpu.packageZoneHelp")
          : undefined
      }
      icon={<CpuIcon />}
      className={`panel-cpu ${className ?? ""}`}
      bodyClassName="sp-stack"
    >
      <div className="sp-duo">
        <div className="sp-metric">
          <span className="eyebrow">{t("cpu.usage")}</span>
          <div className="big-num sp-big-md">
            {usage}
            <small>%</small>
          </div>
          <TrendLine data={usageHistory} height={36} color="var(--color-accent)" min={0} max={100} />
        </div>
        <div className="sp-metric">
          <span
            className="eyebrow"
            // GB10 exposes no CPU package sensor, so the reading is an ACPI/SoC zone:
            // say so rather than letting the tile claim it is the CPU (#142).
            title={
              cpu?.temperatureSource
                ? cpu.temperatureLabel === "CPU"
                  ? t("cpu.cpuSensorHelp", { source: cpu.temperatureSource })
                  : t("cpu.boardSensorHelp", { source: cpu.temperatureSource })
                : undefined
            }
          >
            {cpu?.temperatureLabel && cpu.temperatureLabel !== "CPU"
              ? t("cpu.namedTemperature", { label: cpu.temperatureLabel })
              : t("cpu.temperature")}
          </span>
          <div className="big-num sp-big-md">
            {displayTemp}
            {hasTemp && <small>{temperatureUnit === "fahrenheit" ? "°F" : "°C"}</small>}
          </div>
          {hasTemp && <TrendLine data={tempHistory} height={36} color={tempColor} />}
        </div>
      </div>
      <div className="sp-row">
        <span className="text-muted">{t("cpu.power")}</span>
        <span className="mono text-text">
          {draw}W{tdp > 0 ? ` / ${tdp}W` : ""}
        </span>
      </div>
      {model && (
        <div className="sp-row sp-row--rule">
          <span className="text-muted">{t("cpu.model")}</span>
          <span className="mono sp-clip text-text" title={model}>
            {model}
            {cores != null ? t("cpu.cores", { count: cores }) : ""}
          </span>
        </div>
      )}
    </Panel>
  );
}
