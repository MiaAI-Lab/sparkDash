import { useState } from "react";
import type { SessionSourceAttach, SessionSources, SessionSourcesHealth } from "../api/types";
import { SessionSourceFields } from "./SessionSourceFields";

export function sourceKinds(sources: SessionSources): string[] {
  return Object.keys(sources).filter((key) => Array.isArray(sources[key]));
}

function healthFor(health: SessionSourcesHealth | null, kind: string, id: string) {
  const list = health?.[kind];
  if (!Array.isArray(list)) return undefined;
  return list.find((row) => row.id === id) ?? list.find((row) => !row.id);
}

export function nextAttachId(kind: string, existing: SessionSourceAttach[]) {
  const used = new Set(existing.map((row) => row.id));
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

const HELPER_COMMAND = `BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8788/occupancy\\nToken: %s\\n' "$BIND" "$TOKEN"
OPENCODE_OCCUPANCY_BIND="$BIND" OPENCODE_OCCUPANCY_TOKEN="$TOKEN" node scripts/opencode-occupancy-helper/index.js`;

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
  onPatch: (kind: string, id: string, patch: Partial<SessionSourceAttach>) => void;
  onToken: (id: string, value: string) => void;
  onClearToken: (kind: string, id: string) => void;
  onCheck: (id: string) => void;
  onAdd: (kind: string) => void;
  onRemove: (kind: string, id: string) => void;
}) {
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-xs font-medium text-text">Occupancy sources</h3>
      <p className="text-[10px] leading-snug text-muted">
        Dashboard-wide — set this once on any LLM card. Sessions land on the Spark whose
        host:port they hit. Local = this dashboard host; URL = another machine.
      </p>
      <OpenCodeHelperSetup />
      {sourceKinds(sources).map((kind) => {
        const kindLabel = sources[kind][0]?.kindLabel || kind;
        return (
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
              Add {kindLabel}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function OpenCodeHelperSetup() {
  const [copied, setCopied] = useState(false);
  return (
    <details className="rounded border border-border bg-surface-elevated px-3 py-2">
      <summary className="cursor-pointer text-[10px] font-medium text-text">
        How to attach OpenCode from another computer
      </summary>
      <p className="mt-2 text-[10px] leading-snug text-muted">
        OpenCode has no occupancy HTTP API. Run this helper on the OpenCode machine, then paste
        the printed URL and token into OpenCode below (mode URL). Same-host OpenCode: use Local,
        no helper. Do not bind 0.0.0.0.
      </p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[10px] leading-snug text-muted">
        <li>On that machine: Node 22+, from a sparkDash checkout.</li>
      </ol>
      <div className="mt-2 flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap rounded bg-surface px-2 py-1.5 font-mono text-[10px] text-text">
          {HELPER_COMMAND}
        </pre>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(HELPER_COMMAND).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="shrink-0 rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[10px] leading-snug text-muted" start={2}>
        <li>The command prints the URL and token. Leave the helper running.</li>
        <li>
          Here: OpenCode → URL, paste both, Check, then{" "}
          <span className="font-medium text-text">Save occupancy</span> (separate from Save port
          above).
        </li>
        <li>
          macOS 503: set <code className="text-text">OPENCODE_DATA_DIR</code> to the folder that
          contains <code className="text-text">opencode.db</code> (often{" "}
          <code className="text-text">~/Library/Application Support/opencode</code>).
        </li>
      </ol>
    </details>
  );
}
