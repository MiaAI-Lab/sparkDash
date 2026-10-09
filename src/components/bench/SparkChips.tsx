import { createContext, useContext, type ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";

/** The Sparks a benchmark page can run on, and how to switch between them (provided by BenchPage). */
export interface BenchSparksValue {
  sparks: readonly SparkSnapshot[];
  onSelect: (id: string) => void;
}
export const BenchSparksContext = createContext<BenchSparksValue>({ sparks: [], onSelect: () => {} });
export const useBenchSparks = () => useContext(BenchSparksContext);

interface SparkChipsProps {
  sparks: readonly SparkSnapshot[];
  /** Highlighted Spark; null when something else (Remote) is the target. */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Extra chips after the Sparks, e.g. Remote. */
  extra?: ReactNode;
  ariaLabel?: string;
}

/** One chip per Spark, with a status dot; the chosen one is highlighted. */
export function SparkChips({ sparks, activeId, onSelect, extra, ariaLabel = "Spark to benchmark" }: SparkChipsProps) {
  return (
    <div className="bench-runon__chips" role="group" aria-label={ariaLabel}>
      {sparks.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`bench-runon__chip${activeId === s.id ? " is-on" : ""}`}
          aria-pressed={activeId === s.id}
          onClick={() => onSelect(s.id)}
          title={s.online ? (isWorkerSpark(s) ? `${s.name} is a worker: no local LLM, saved results only` : undefined) : `${s.name} is offline`}
        >
          <i className={`sdot ${s.online ? "" : "sdot--warn"}`} aria-hidden />
          {s.name}
          {isWorkerSpark(s) ? <small className="bench-runon__tag">worker</small> : null}
        </button>
      ))}
      {extra}
    </div>
  );
}
