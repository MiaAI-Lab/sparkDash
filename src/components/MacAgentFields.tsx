import type { MacAgentConfig } from "../api/types";

/**
 * Mac node agent endpoint fields (Apple Silicon units only).
 *
 * Left empty, the Mac keeps being read over SSH with stock macOS tools. Pointed
 * at the on-device agent, the unit gains what SSH cannot give it: the runtime
 * inventory (which engine is serving what, on which port) and an explicit list
 * of metrics this Mac cannot measure, so the dashboard says "unavailable"
 * instead of showing zeros for things a DGX Spark can read.
 */
export function MacAgentFields({
  agent,
  disabled,
  onChange,
  className = "",
}: {
  agent?: MacAgentConfig | null;
  disabled?: boolean;
  onChange: (next: MacAgentConfig | null) => void;
  className?: string;
}) {
  const port = agent?.port != null ? String(agent.port) : "";
  const url = agent?.url ?? "";
  const setPort = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed && !url) return onChange(null);
    onChange({ url: url || null, host: agent?.host ?? null, port: trimmed ? Number(trimmed) : null });
  };
  const setUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed && !port) return onChange(null);
    onChange({ url: trimmed || null, host: agent?.host ?? null, port: port ? Number(port) : null });
  };
  const fieldClass =
    "w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent";

  return (
    <div className={`space-y-2 ${className}`} data-testid="mac-agent-fields">
      <div>
        <label className="mb-1 block text-xs text-muted">
          Mac node agent port (optional — empty reads the Mac over SSH only)
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={port}
          disabled={disabled}
          onChange={(e) => setPort(e.target.value)}
          className={fieldClass}
          placeholder="8790"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted">
          Mac node agent URL override (optional — wins over host + port)
        </label>
        <input
          type="text"
          value={url}
          disabled={disabled}
          onChange={(e) => setUrl(e.target.value)}
          className={fieldClass}
          placeholder="http://mac.tail24e2e0.ts.net:8790"
        />
      </div>
      <p className="text-[10px] leading-snug text-muted">
        With an agent, the unit reports its model runtimes and the metrics macOS
        only hands to root, so those tiles read &quot;unavailable&quot; instead of 0.
      </p>
    </div>
  );
}
