import type { SessionSourceAttach, SessionSources, SessionSourcesHealth } from "../api/types";
import { SessionSourceFields, SOURCE_IDS, SOURCE_LABELS } from "./SessionSourceFields";

function healthFor(
  health: SessionSourcesHealth | null,
  kind: (typeof SOURCE_IDS)[number],
  id: string
) {
  const list = health?.[kind];
  if (!Array.isArray(list)) return undefined;
  return list.find((row) => row.id === id) ?? list.find((row) => !row.id);
}

export function nextAttachId(kind: (typeof SOURCE_IDS)[number], existing: SessionSourceAttach[]) {
  const used = new Set(existing.map((row) => row.id));
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

export function SessionSourcesPanel({
  sources,
  tokenDrafts,
  health,
  checkingId,
  onPatch,
  onToken,
  onClearToken,
  onCheck,
  onAdd,
  onRemove,
}: {
  sources: SessionSources;
  tokenDrafts: Record<string, string>;
  health: SessionSourcesHealth | null;
  checkingId: string | null;
  onPatch: (kind: (typeof SOURCE_IDS)[number], id: string, patch: Partial<SessionSourceAttach>) => void;
  onToken: (id: string, value: string) => void;
  onClearToken: (kind: (typeof SOURCE_IDS)[number], id: string) => void;
  onCheck: (id: string) => void;
  onAdd: (kind: (typeof SOURCE_IDS)[number]) => void;
  onRemove: (kind: (typeof SOURCE_IDS)[number], id: string) => void;
}) {
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-xs font-medium text-text">Session sources</h3>
      <p className="text-[10px] leading-snug text-muted">
        Optional OpenClaw and Hermes Agent conversations. Add one attach per gateway. Local
        defaults are ~/.openclaw (or OPENCLAW_STATE_DIR) and ~/.hermes (or HERMES_HOME). URL
        mode talks to the product gateway — OpenClaw uses its WebSocket session list, not the
        Control UI page.
      </p>
      {SOURCE_IDS.map((kind) => (
        <div key={kind} className="space-y-2">
          {sources[kind].map((src) => (
            <SessionSourceFields
              key={src.id}
              kind={kind}
              source={src}
              tokenDraft={tokenDrafts[src.id] ?? ""}
              health={healthFor(health, kind, src.id)}
              checking={checkingId === "*" || checkingId === src.id}
              canRemove={sources[kind].length > 1}
              onSource={(patch) => onPatch(kind, src.id, patch)}
              onToken={(value) => onToken(src.id, value)}
              onClearToken={() => onClearToken(kind, src.id)}
              onCheck={() => onCheck(src.id)}
              onRemove={() => onRemove(kind, src.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => onAdd(kind)}
            className="rounded border border-border bg-surface-elevated px-2 py-1.5 text-[10px] text-muted hover:bg-surface-hover"
          >
            Add {SOURCE_LABELS[kind]} gateway
          </button>
        </div>
      ))}
    </div>
  );
}
