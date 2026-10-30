import { useEffect, useState } from "react";
import { fetchPowerMeterStatus, type PowerMeterStatus } from "../api/powerMeters";

const REFRESH_MS = 60_000;

let cached: PowerMeterStatus | null = null;
let inflight: Promise<PowerMeterStatus | null> | null = null;
const listeners = new Set<(status: PowerMeterStatus | null) => void>();

function load(): Promise<PowerMeterStatus | null> {
  if (!inflight) {
    inflight = Promise.resolve()
      .then(() => fetchPowerMeterStatus())
      .then((status) => {
        cached = status;
        return status;
      })
      // An older server has no such route: treat it as "not configured".
      .catch(() => cached)
      .finally(() => {
        inflight = null;
      });
    void inflight.then((status) => listeners.forEach((fn) => fn(status)));
  }
  return inflight;
}

/** Test hook: forget the shared status. */
export function resetPowerMeterStatusCache(): void {
  cached = null;
  inflight = null;
}

/**
 * Whether optional power meters are configured, shared by every caller and refreshed
 * every minute. Null until the first answer arrives.
 */
export function usePowerMeterStatus(): PowerMeterStatus | null {
  const [status, setStatus] = useState<PowerMeterStatus | null>(cached);
  useEffect(() => {
    listeners.add(setStatus);
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => {
      listeners.delete(setStatus);
      window.clearInterval(timer);
    };
  }, []);
  return status;
}
