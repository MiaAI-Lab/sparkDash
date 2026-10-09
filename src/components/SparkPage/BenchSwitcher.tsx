export type BenchKind = "decode" | "prefill" | "quality";

const LABELS: Record<BenchKind, string> = {
  decode: "Decode",
  prefill: "Prefill",
  quality: "Quality",
};

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
  if (!onSwitch) return null;
  return (
    <div className="seg" role="tablist" aria-label="Benchmark type">
      {(Object.keys(LABELS) as BenchKind[]).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={k === active}
          className={k === active ? "is-on" : ""}
          disabled={disabled && k !== active}
          onClick={() => k !== active && onSwitch(k)}
        >
          {LABELS[k]}
        </button>
      ))}
    </div>
  );
}
