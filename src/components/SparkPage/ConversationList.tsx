import type { ConversationBadge, ConversationRow, ConversationSource } from "../../api/types";

const SOURCE_LABEL: Record<ConversationSource, string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

const BADGE_LABEL: Record<ConversationBadge, string> = {
  generating: "Generating",
  stalled: "Stalled",
  unknown: "Unknown",
};

interface ConversationListProps {
  conversations: ConversationRow[];
}

export function ConversationList({ conversations }: ConversationListProps) {
  if (conversations.length === 0) return null;

  return (
    <ul className="occupancy" aria-label="Occupancy on this LLM">
      {conversations.map((row) => (
        <li key={row.id} className={`occupancy-row is-${row.badge}`}>
          <span className="occupancy-dot" aria-hidden="true" />
          <span className="occupancy-source">{SOURCE_LABEL[row.source]}</span>
          <span className="occupancy-handle" title={row.handle}>
            {row.handle}
          </span>
          <span className="occupancy-state">{BADGE_LABEL[row.badge]}</span>
        </li>
      ))}
    </ul>
  );
}
