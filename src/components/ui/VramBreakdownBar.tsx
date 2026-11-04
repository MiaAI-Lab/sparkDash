import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatMb } from "../../shared/formatBytes";
import {
  headroomTextClass,
  kvNearlyFull,
  legendItems,
  type VramBreakdown,
  type VramSegmentKey,
} from "../../shared/vramBreakdown";

interface VramBreakdownBarProps {
  label: string;
  breakdown: VramBreakdown;
  /** One-line legend under the bar (GPU panel). The tooltip carries it either way. */
  showLegend?: boolean;
}

const pct = (mb: number, total: number) =>
  `${total > 0 ? Math.min(100, Math.max(0, (mb / total) * 100)).toFixed(2) : 0}%`;

const gb = (n: number) => `${n.toFixed(1)} GB`;

/** "/usr/bin/python3" → "python3": the card is too narrow for interpreter paths. */
const processLabel = (name: string) => name.split("/").filter(Boolean).pop() || name;

function Swatch({ kind }: { kind: VramSegmentKey }) {
  return (
    <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-sm mem-seg-${kind}`} />
  );
}

function TipRow({
  swatch,
  label,
  detail,
  value,
  indent = false,
  valueClass = "text-text",
}: {
  swatch?: VramSegmentKey;
  label: string;
  detail?: string;
  value: ReactNode;
  indent?: boolean;
  valueClass?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${indent ? "pl-3 text-muted" : ""}`}>
      <span className="flex min-w-0 items-baseline gap-1.5">
        {swatch ? <Swatch kind={swatch} /> : null}
        <span className="shrink-0">{label}</span>
        {/* Whitespace between flex items is not drawn, but keeps the read-out
            text (aria-describedby) from running words together. */}
        {detail ? (
          <>
            {" "}
            <span className="min-w-0 truncate text-muted">{detail}</span>
          </>
        ) : null}
      </span>{" "}
      <span className={`shrink-0 font-tabular ${valueClass}`}>{value}</span>
    </div>
  );
}

/**
 * VRAM bar split by what holds the memory — LLM engine, system/CPU (unified
 * pool), other GPU use — over a free track. Colour says category; the only
 * severity is the headroom figure in the header. Hover or keyboard focus opens
 * a breakdown; Escape closes it. It also closes when something else takes
 * over — a press or focus outside the bar, a scroll, the window losing focus —
 * because a dialog that opens under a still pointer never fires mouseleave and
 * would otherwise leave the breakdown hanging behind it.
 */
export function VramBreakdownBar({ label, breakdown: b, showLegend = false }: VramBreakdownBarProps) {
  const { t } = useTranslation("overview");
  const tipId = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hover || focus) && !dismissed;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      !(target instanceof Node && rootRef.current?.contains(target));
    const close = () => {
      setHover(false);
      setFocus(false);
      setDismissed(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (outside(e.target)) close();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (outside(e.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, [open]);
  const kvFull = kvNearlyFull(b);
  const kvPct = b.kv?.usage != null ? `${Math.round(b.kv.usage * 100)}%` : null;
  // Free is already the header's figure; the legend only names what holds the memory.
  const items = legendItems(b).filter((it) => it.key !== "free");
  const pool = b.model === "unified" ? t("memory.unifiedMemory") : t("memory.vram");
  const legendLabel = (key: VramSegmentKey) => {
    if (key === "engine") return t("memory.legend.engine");
    if (key === "system") return t("memory.legend.system");
    if (key === "other") return t("memory.legend.other");
    return t("memory.legend.gpu");
  };
  const verdictText =
    b.tone === "critical"
      ? b.model === "unified" ? t("memory.verdict.critical.unified") : t("memory.verdict.critical.vram")
      : b.tone === "low"
        ? b.model === "unified" ? t("memory.verdict.low.unified") : t("memory.verdict.low.vram")
        : kvFull ? t("memory.verdict.kvFull") : t("memory.verdict.ok");

  return (
    <div
      ref={rootRef}
      className="relative space-y-1 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-describedby={tipId}
      data-vram-breakdown
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        if (!focus) setDismissed(false);
      }}
      onFocus={() => setFocus(true)}
      onBlur={() => {
        setFocus(false);
        if (!hover) setDismissed(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setDismissed(true);
        }
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className={`font-tabular text-sm ${headroomTextClass(b.tone)}`} data-headroom={b.tone}>
          {t("memory.free", { value: formatMb(b.freeMB) })}
        </span>
      </div>
      <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-border">
        {b.segments.map((s) => (
          <div
            key={s.key}
            data-segment={s.key}
            className={`metric-bar-fill h-full shrink-0 transition-[width] duration-300 ease-out mem-seg-${s.key}`}
            style={{ ["--bar-pct" as string]: pct(s.mb, b.totalMB) }}
          />
        ))}
      </div>
      {showLegend && (
        <div className="flex flex-wrap items-center gap-x-1.5 font-tabular text-[10px] text-muted" data-legend>
          {items.map((it, i) => {
            if (it.key === "free") return null;
            return (
              <span key={it.key} className="inline-flex items-center gap-1">
                {i > 0 ? <span aria-hidden>{" · "}</span> : null}
                <Swatch kind={it.key} />
                {legendLabel(it.key)} {it.gb} GB
              </span>
            );
          })}
        </div>
      )}
      <div
        id={tipId}
        role="tooltip"
        hidden={!open}
        className="absolute left-0 right-0 top-full z-20 mt-1 space-y-0.5 rounded-md border border-border bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal leading-snug text-text shadow-lg"
      >
        <div className="pb-0.5 text-muted">
          {t("memory.usedOf", { pool, used: formatMb(b.usedMB), total: formatMb(b.totalMB) })}
        </div>
        {b.engine && (
          <>
            <TipRow
              swatch="engine"
              label={t("memory.engine")}
              detail={`${processLabel(b.engine.name)} · pid ${b.engine.pid}`}
              value={formatMb(b.engine.mb)}
            />
            {b.kv?.weightsGb != null && <TipRow indent label={t("memory.weights")} value={gb(b.kv.weightsGb)} />}
            {b.kv?.poolGb != null && <TipRow indent label={t("memory.kvPool")} value={gb(b.kv.poolGb)} />}
            {b.kv && (
              <TipRow
                indent
                label={t("memory.kvInUse")}
                value={kvPct ?? t("memory.notReportedBy", { backend: b.kv.backend ?? t("memory.thisBackend") })}
                valueClass={kvFull ? "text-warning" : kvPct != null ? "text-text" : "text-muted"}
              />
            )}
          </>
        )}
        {b.systemMB != null && <TipRow swatch="system" label={t("memory.systemCpu")} value={formatMb(b.systemMB)} />}
        {b.engine ? (
          b.otherMB > 0 && <TipRow swatch="other" label={t("memory.otherGpu")} value={formatMb(b.otherMB)} />
        ) : (
          <TipRow swatch="gpu" label={t("card.gpu")} value={formatMb(b.otherMB)} />
        )}
        <TipRow label={t("memory.freeLabel")} value={formatMb(b.freeMB)} valueClass={headroomTextClass(b.tone)} />
        <div
          className={`mt-1 border-t border-border pt-1 ${
            b.tone === "ok" ? (kvFull ? "text-warning" : "text-muted") : headroomTextClass(b.tone)
          }`}
          data-verdict
        >
          {verdictText}
        </div>
      </div>
    </div>
  );
}
