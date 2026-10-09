import { useEffect, useRef, useState } from "react";

/**
 * Rolling series of a live reading for signals the central metrics store does
 * not keep (network rates). Pushes one sample each time `tick` changes (pass
 * the snapshot slice, which is replaced on every WS frame) and resets when
 * `key` changes (Spark switch). Starts empty after a page reload.
 */
export function useLocalSeries(
  key: string,
  value: number | null | undefined,
  tick: unknown,
  max = 60
): readonly number[] {
  const [series, setSeries] = useState<number[]>([]);
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      setSeries([]);
      return;
    }
    if (value == null || !Number.isFinite(value)) return;
    setSeries((prev) => {
      const next = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice();
      next.push(value);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, key]);
  return series;
}
