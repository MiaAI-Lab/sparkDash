import type { SessionSourceAttach, SessionSourceHealth, SessionSourceMode } from "../api/types";

export const SOURCE_LABELS = { openclaw: "OpenClaw", hermes: "Hermes Agent", opencode: "OpenCode" } as const;
export const SOURCE_IDS = ["openclaw", "hermes", "opencode"] as const;
const MODE_OPTIONS: { value: SessionSourceMode; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "url", label: "URL" },
  { value: "state-dir", label: "State dir" },
];

const fieldClass =
  "w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent";

export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
        on ? "is-on" : ""
      }`}
    >
      <span
        className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
          on ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export type HealthTone = "muted" | "ok" | "danger";

export interface HealthView {
  label: string;
  tone: HealthTone;
  found?: number;
  mapped?: number;
  detail?: string;
}

export function healthView(
  health: SessionSourceHealth | undefined,
  checking: boolean
): HealthView | null {
  if (checking) return { label: "Checking", tone: "muted" };
  if (!health) return null;
  if (health.status === "disabled") return { label: "Off", tone: "muted" };
  if (health.status === "error") {
    return { label: "Unreachable", tone: "danger", detail: health.error || undefined };
  }
  return { label: "Connected", tone: "ok", found: health.found, mapped: health.mapped };
}

export function SessionSourceFields({
  kind,
  source,
  tokenDraft,
  health,
  checking,
  canRemove,
  onSource,
  onToken,
  onClearToken,
  onCheck,
  onRemove,
}: {
  kind: (typeof SOURCE_IDS)[number];
  source: SessionSourceAttach;
  tokenDraft: string;
  health?: SessionSourceHealth;
  checking: boolean;
  canRemove: boolean;
  onSource: (patch: Partial<SessionSourceAttach>) => void;
  onToken: (value: string) => void;
  onClearToken: () => void;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const status = healthView(health, checking);
  const title = source.label?.trim() || SOURCE_LABELS[kind];
  return (
    <div className="space-y-2 rounded border border-border px-3 py-2">
      <div className="flex items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-3 text-xs text-muted">
          <Toggle on={source.enabled} onClick={() => onSource({ enabled: !source.enabled })} />
          <span className="truncate text-text">{title}</span>
        </label>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded border border-border bg-surface-elevated px-2 py-1 text-[10px] text-muted hover:bg-surface-hover"
          >
            Remove
          </button>
        )}
      </div>
      <input
        type="text"
        value={source.label ?? ""}
        onChange={(e) => onSource({ label: e.target.value })}
        placeholder="Optional label"
        className={fieldClass}
        aria-label={`${SOURCE_LABELS[kind]} label`}
      />
      <select
        value={source.mode}
        onChange={(e) => onSource({ mode: e.target.value as SessionSourceMode })}
        className={fieldClass}
        aria-label={`${SOURCE_LABELS[kind]} mode`}
      >
        {MODE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {source.mode === "local" && (
        <p className="text-[10px] leading-snug text-muted">
          {kind === "opencode"
            ? `Sessions ${source.conventionalStateDir}; providers ${source.conventionalConfigDir || "~/.config/opencode"}`
            : `Uses ${source.conventionalStateDir}`}
        </p>
      )}
      {source.mode === "url" && (
        <input
          type="text"
          value={source.url}
          onChange={(e) => onSource({ url: e.target.value })}
          placeholder={
            kind === "openclaw"
              ? "http://127.0.0.1:18789"
              : kind === "opencode"
                ? "http://127.0.0.1:8788/occupancy"
                : "http://127.0.0.1:8787"
          }
          className={fieldClass}
          aria-label={`${SOURCE_LABELS[kind]} URL`}
        />
      )}
      {kind === "hermes" && source.mode === "url" && (
        <input
          type="text"
          value={source.username ?? ""}
          onChange={(e) => onSource({ username: e.target.value })}
          placeholder="Username (default admin)"
          className={fieldClass}
          aria-label={`${SOURCE_LABELS[kind]} username`}
        />
      )}
      {source.mode === "state-dir" && (
        <input
          type="text"
          value={source.stateDir}
          onChange={(e) => onSource({ stateDir: e.target.value })}
          placeholder="State directory"
          className={fieldClass}
          aria-label={`${SOURCE_LABELS[kind]} state directory`}
        />
      )}
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="new-password"
          value={tokenDraft}
          onChange={(e) => onToken(e.target.value)}
          placeholder={source.hasToken ? "Token stored — leave blank to keep" : "Optional token"}
          className={fieldClass}
          aria-label={`${SOURCE_LABELS[kind]} token`}
        />
        {source.hasToken && !tokenDraft && (
          <button
            type="button"
            onClick={onClearToken}
            className="shrink-0 rounded border border-border bg-surface-elevated px-2 py-1.5 text-[10px] text-muted hover:bg-surface-hover"
          >
            Clear
          </button>
        )}
      </div>
      <div className="session-health">
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          className="shrink-0 rounded border border-border bg-surface-elevated px-2 py-1.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check"}
        </button>
        {status && (
          <div className="session-health-body">
            <span className={`session-health-pill is-${status.tone}`}>{status.label}</span>
            {status.found != null && (
              <span className="session-health-metric">
                <span className="session-health-k">found</span>
                <span className="session-health-v">{status.found}</span>
              </span>
            )}
            {status.mapped != null && (
              <span className="session-health-metric">
                <span className="session-health-k">on Sparks</span>
                <span className="session-health-v">{status.mapped}</span>
              </span>
            )}
            {status.detail && <p className="session-health-detail">{status.detail}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
