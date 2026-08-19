import type { ConversationRow } from "../../api/types";
import { PlusIcon } from "../ui/icons";

const SOURCE_LABEL: Record<string, string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
  opencode: "OpenCode",
  omp: "oh-my-pi",
};

interface ConversationListProps {
  conversations: ConversationRow[];
  onAddHarness?: () => void;
}

function formatSessionAge(lastUsedAt: number | undefined, now: number): string {
  if (lastUsedAt == null || !Number.isFinite(lastUsedAt)) return "—";
  const delta = Math.max(0, now - lastUsedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "now";
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  if (delta < 7 * day) return `${Math.floor(delta / day)}d`;
  return new Date(lastUsedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function occupancyTone(row: ConversationRow, now: number): "generating" | "recent" | "warm" | "idle" {
  if (row.badge === "generating") return "generating";
  if (row.lastUsedAt == null || !Number.isFinite(row.lastUsedAt)) return "idle";
  const age = now - row.lastUsedAt;
  if (age < 5 * 60_000) return "recent";
  if (age < 60 * 60_000) return "warm";
  return "idle";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function contextLabel(row: ConversationRow): string {
  if (row.contextUsed == null) return "";
  const used = `${row.contextApprox ? "~" : ""}${formatTokens(row.contextUsed)}`;
  if (row.contextWindow == null) return used;
  return `${used}/${formatTokens(row.contextWindow)}`;
}

function contextTitle(row: ConversationRow): string {
  const used = row.contextUsed?.toLocaleString();
  const window = row.contextWindow?.toLocaleString();
  if (used && window) return `${row.contextApprox ? "~" : ""}${used} / ${window} tokens`;
  if (used) return `${row.contextApprox ? "~" : ""}${used} tokens`;
  if (window) return `${window} token window`;
  return "";
}

function stateLabel(row: ConversationRow, now: number): string {
  if (row.badge === "generating") return "Generating";
  return formatSessionAge(row.lastUsedAt, now);
}

function laneLabel(source: string, agent?: string, gateway?: string): string {
  const parts = [SOURCE_LABEL[source] ?? source];
  if (gateway) parts.push(gateway);
  if (agent) parts.push(agent);
  return parts.join(" · ");
}

function groupConversations(rows: ConversationRow[]) {
  const groups: { key: string; label: string; rows: ConversationRow[] }[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.source}\0${row.gateway ?? ""}\0${row.agent ?? ""}`;
    const existing = index.get(key);
    if (existing != null) {
      groups[existing].rows.push(row);
      continue;
    }
    index.set(key, groups.length);
    groups.push({ key, label: laneLabel(row.source, row.agent, row.gateway), rows: [row] });
  }
  return groups;
}

export function ConversationList({ conversations, onAddHarness }: ConversationListProps) {
  const now = Date.now();
  const groups = groupConversations(conversations);

  return (
    <div className="occupancy">
      <div className="occupancy-head">
        <span className="occupancy-head-count">{conversations.length}</span>
        <span className="occupancy-head-title">Sessions</span>
        {onAddHarness && (
          <button
            type="button"
            title="Add harness"
            aria-label="Add harness"
            onClick={onAddHarness}
            className="occupancy-head-add"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {conversations.length === 0 ? (
        <div className="occupancy-empty">
          <p>No sessions on this LLM. Attach OpenClaw, Hermes, OpenCode, or oh-my-pi.</p>
          {onAddHarness && (
            <button type="button" onClick={onAddHarness} className="occupancy-add-harness">
              + Harness
            </button>
          )}
        </div>
      ) : (
        <div className="occupancy-list" aria-label="Occupancy on this LLM">
          {groups.map((group) => (
            <section key={group.key} className="occupancy-lane">
              <h3 className="occupancy-lane-label">{group.label}</h3>
              <ul className="occupancy-lane-list" aria-label={group.label}>
                {group.rows.map((row) => {
                  const ctx = contextLabel(row);
                  return (
                    <li key={row.id} className={`occupancy-row is-${occupancyTone(row, now)}`}>
                      <span className="occupancy-dot" aria-hidden="true" />
                      <span className="occupancy-handle" title={row.handle}>
                        {row.handle}
                      </span>
                      <span className="occupancy-ctx" title={ctx ? contextTitle(row) : undefined}>
                        {ctx}
                      </span>
                      <span className="occupancy-state">{stateLabel(row, now)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
