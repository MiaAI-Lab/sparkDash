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
  const { t } = useTranslation("benchmarks");
  const labels: Record<BenchKind, string> = {
    decode: t("catalog.decode.label"),
    prefill: t("catalog.prefill.label"),
    quality: t("catalog.quality.label"),
  };
  if (!onSwitch) return null;
  return (
    <div className="seg" role="tablist" aria-label={t("switcher.aria")}>
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
