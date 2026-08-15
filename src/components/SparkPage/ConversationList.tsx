import type { ConversationBadge, ConversationRow, ConversationSource } from "../../api/types";

const SOURCE_LABEL: Record<ConversationSource, string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
};

const BADGE_CLASS: Record<ConversationBadge, string> = {
  generating: "text-accent",
  stalled: "text-muted",
  unknown: "text-warning",
};

interface ConversationListProps {
  conversations: ConversationRow[];
}

export function ConversationList({ conversations }: ConversationListProps) {
  if (conversations.length === 0) return null;

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      {conversations.map((row) => (
        <div
          key={row.id}
          className="flex items-center justify-between gap-2"
        >
          <div className="min-w-0 flex-1 truncate">
            <span className="text-xs text-muted">{SOURCE_LABEL[row.source]}</span>
            <span className="ml-2 text-xs text-text">{row.handle}</span>
          </div>
          <span className={`shrink-0 text-xs ${BADGE_CLASS[row.badge]}`}>{row.badge}</span>
        </div>
      ))}
    </div>
  );
}
