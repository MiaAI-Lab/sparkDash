import type { PowerMeterMeterStatus, PowerMeterStatus } from "../../api/powerMeters";
import { activeTimeZone } from "../../shared/timeZone";
import { Tag, type TagTone } from "../ui/Tag";

/** The provider's own name for a meter; its type if the server is too old to send one. */
export function meterLabel(m: Pick<PowerMeterMeterStatus, "label" | "type">): string {
  return m.label || m.type;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: activeTimeZone() });
}

function problem(m: PowerMeterMeterStatus): string | null {
  if (m.health === "error" || m.health === "unavailable") return m.error ?? "not reading";
  if (m.history.state === "error") return `history: ${m.history.lastError ?? "failed"}`;
  return null;
}

function chip(m: PowerMeterMeterStatus): { tone: TagTone; suffix: string } {
  if (problem(m)) return { tone: "bad", suffix: m.health === "ok" ? " · no history" : " · not reading" };
  if (m.health === "pending") return { tone: "neutral", suffix: " · connecting" };
  if (m.history.state === "backfilling" || m.history.state === "pending") return { tone: "neutral", suffix: " · loading history" };
  return { tone: "good", suffix: "" };
}

/** One chip per meter: green while it reads; details (address, record, per-unit watts) on hover. */
export function MeterChips({ status, nameOf }: { status: PowerMeterStatus | null; nameOf: (id: string) => string }) {
  if (!status?.enabled) return null;
  return (
    <>
      {status.meters.map((m) => {
        const units = status.units.filter((u) => u.meter === m.id);
        const marks = units.map((u) => u.reconciledThroughMs).filter((v): v is number => v != null);
        const { tone, suffix } = chip(m);
        const title = [
          m.target,
          `every ${Math.round(status.pollIntervalMs / 1000)} s`,
          marks.length ? `record through ${clock(Math.min(...marks))}` : null,
          ...units.map((u) => `${nameOf(u.id)} ${u.fresh && u.watts != null ? `${Math.round(u.watts)} W` : "—"}`),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Tag key={m.id} tone={tone} title={title} className="en-meter-chip">
            {meterLabel(m)}
            {suffix}
          </Tag>
        );
      })}
    </>
  );
}

/** A banner only when something is wrong: a bad config, or a meter that is not reading. */
export function MeterAlert({ status }: { status: PowerMeterStatus | null }) {
  if (!status) return null;
  if (!status.enabled) {
    return status.state === "invalid" ? (
      <p className="en-banner en-banner--warn" role="alert">Power meters off: {status.error}</p>
    ) : null;
  }
  const issues = status.meters.map((m) => [m, problem(m)] as const).filter(([, p]) => p);
  if (!issues.length) return null;
  return (
    <p className="en-banner en-banner--warn" role="alert">
      {issues.map(([m, p]) => `${meterLabel(m)}: ${p}`).join("; ")}. Missing readings are filled from the estimate.
    </p>
  );
}
