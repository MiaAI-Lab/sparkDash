import { useTranslation } from "react-i18next";

export type BenchKind = "decode" | "prefill" | "quality";

/**
 * Segmented switch shown in every benchmark dialog header so Decode, Prefill and
 * Quality read as one tool. The parent (LlmPanel) owns which dialog is open and
 * swaps it when `onSwitch` fires. Hidden when no handler is supplied.
 */
export function BenchSwitcher({
  active,
  onSwitch,
  disabled = false,
}: {
  active: BenchKind;
  onSwitch?: (kind: BenchKind) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!onSwitch) return null;
  const labels: Record<BenchKind, string> = {
    decode: t("bench.kind.decode", "Decode"),
    prefill: t("bench.kind.prefill", "Prefill"),
    quality: t("bench.kind.quality", "Quality"),
  };
  return (
    <div className="seg" role="tablist" aria-label={t("bench.type", "Benchmark type")}>
      {(Object.keys(labels) as BenchKind[]).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={k === active}
          className={k === active ? "is-on" : ""}
          disabled={disabled && k !== active}
          onClick={() => k !== active && onSwitch(k)}
        >
          {labels[k]}
        </button>
      ))}
    </div>
  );
}
