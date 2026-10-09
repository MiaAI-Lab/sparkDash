import { useEffect, useState } from "react";
import { fetchRestartAvailable, restartServer } from "../../api/client";

/** Wait for the server to go down and come back, then reload the page. */
async function waitForRestart() {
  let sawDown = false;
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok && (sawDown || Date.now() - started > 8000)) return;
    } catch {
      sawDown = true;
    }
  }
}

/** "Restart sparkDash" with an in-place confirm. Renders nothing when the server can't restart itself. */
export function RestartButton({ className = "btn btn--primary btn--sm" }: { className?: string }) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<"idle" | "confirm" | "restarting" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    fetchRestartAvailable()
      .then((r) => { if (!cancelled) setAvailable(r.available); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!available) return null;

  const run = async () => {
    setState("restarting");
    try {
      await restartServer();
      await waitForRestart();
      window.location.reload();
    } catch {
      setState("error");
    }
  };

  if (state === "restarting") {
    return <span className="tag" role="status">Restarting…</span>;
  }
  if (state === "confirm") {
    return (
      <span role="group" aria-label="Confirm restart">
        <span className="ov-note">Restart now? Running benchmarks will be interrupted.</span>{" "}
        <button type="button" className={className} onClick={() => void run()}>Restart</button>{" "}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setState("idle")}>Cancel</button>
      </span>
    );
  }
  return (
    <button type="button" className={className} onClick={() => setState("confirm")}>
      {state === "error" ? "Restart failed — retry" : "Restart sparkDash"}
    </button>
  );
}
