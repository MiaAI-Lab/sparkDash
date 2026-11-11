import { useEffect, useId, useState } from "react";
import { ApiError, fetchDockerStorage } from "../../api/client";
import type { DockerStorage, SparkSnapshot } from "../../api/types";

/** Another Spark's own Docker list, read while a confirmation sheet is open. */
export interface PeerDockerList {
  spark: SparkSnapshot;
  state: "loading" | "ready" | "error";
  /** The light list (images and containers, without Docker's disk-use totals), once read. */
  data: DockerStorage | null;
  /** Docker there needed administrator rights, so changes there ask for them too. */
  elevate: boolean;
  error?: string;
}

/**
 * The other Sparks' Docker lists while `open` (read-only). Docker that refuses the account is asked again through
 * sudo, which works when that Spark has passwordless sudo or a remembered password. Every Spark has an entry from
 * the first render, "loading" until its own answer arrives, so a sheet can lay out one row per Spark at once.
 * `refreshKey`: read them again when it changes while open.
 */
export function usePeerDockerLists(open: boolean, peerSparks: readonly SparkSnapshot[], refreshKey = ""): PeerDockerList[] {
  const peerKey = peerSparks.map((s) => s.id).join(",");
  const key = `${peerKey}|${refreshKey}`;
  // Answers belong to one opening: older ones are never shown for a new one.
  const [answers, setAnswers] = useState<{ key: string; byId: Record<string, PeerDockerList> }>({ key: "", byId: {} });

  useEffect(() => {
    if (!open || peerSparks.length === 0) {
      // Closed: forget, so the next opening starts from "Checking…" rather than an old answer.
      setAnswers((prev) => (prev.key === "" ? prev : { key: "", byId: {} }));
      return;
    }
    let cancelled = false;
    setAnswers({ key, byId: {} });
    for (const spark of peerSparks) {
      void (async () => {
        let elevate = false;
        let next: PeerDockerList;
        try {
          let data: DockerStorage;
          try {
            data = await fetchDockerStorage(spark.id, { light: true });
          } catch (err) {
            if (!(err instanceof ApiError) || err.code !== "docker-denied") throw err;
            elevate = true;
            data = await fetchDockerStorage(spark.id, { light: true, sudo: true });
          }
          next = { spark, state: "ready", data, elevate };
        } catch (err) {
          next = { spark, state: "error", data: null, elevate, error: err instanceof Error ? err.message : "Could not check" };
        }
        if (!cancelled) setAnswers((prev) => (prev.key === key ? { key, byId: { ...prev.byId, [spark.id]: next } } : prev));
      })();
    }
    return () => {
      cancelled = true;
    };
    // Read again only when the sheet opens, for other Sparks, or when the caller asks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  const current = open && answers.key === key ? answers.byId : {};
  return peerSparks.map((spark) => current[spark.id] ?? { spark, state: "loading", data: null, elevate: false });
}

/** One Spark's row in the "Also on your other Sparks" block. */
export interface PeerRowView {
  id: string;
  name: string;
  /** Next to the name, e.g. "has all these 2 images". */
  title?: string;
  /** One line under it, always present (it is also why a box cannot be ticked). */
  detail: string;
  tone?: "error" | "none";
  /** The box can be ticked: the answer is in and there is something to do there. */
  selectable: boolean;
}

interface PeersBlockProps {
  hint: string;
  rows: PeerRowView[];
  picked: ReadonlySet<string>;
  busy: boolean;
  onToggle: (id: string) => void;
}

/**
 * "Also on your other Sparks": one row per Spark from the first frame, each with a one-line detail, so the sheet
 * never changes size while the answers come in. Nothing is ticked until the person ticks it.
 */
export function PeersBlock({ hint, rows, picked, busy, onToggle }: PeersBlockProps) {
  const baseId = useId();
  return (
    <div className="st-peers" aria-live="polite">
      <div className="st-peers__title">Also on your other Sparks</div>
      <p className="st-hint">{hint}</p>
      {rows.map((r, i) => (
        <label key={r.id} className={`check-row st-peers__row${r.tone === "error" ? " is-error" : ""}${r.tone === "none" ? " is-none" : ""}`}>
          <input
            type="checkbox"
            checked={r.selectable && picked.has(r.id)}
            disabled={busy || !r.selectable}
            onChange={() => onToggle(r.id)}
            aria-describedby={`${baseId}-${i}`}
          />
          <span>
            <b>{r.name}</b> {r.title ?? ""}
            <small className="st-hint st-peers__detail" id={`${baseId}-${i}`} title={r.detail}>
              {r.detail}
            </small>
          </span>
        </label>
      ))}
    </div>
  );
}

/** A copy of a set with one value added or taken out (ticked Sparks, categories). */
export const toggled = <T,>(set: ReadonlySet<T>, id: T): Set<T> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};
