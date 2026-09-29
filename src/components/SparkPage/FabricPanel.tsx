import { useState } from "react";
import { Panel } from "../ui/Panel";
import { ChevronDownIcon } from "../ui/icons";

interface FabricPanelProps {
  note?: string | null;
  className?: string;
}

/** Closeable fabric note. No MikroTik scrape — QSFP lives on Network. */
export function FabricPanel({ note, className = "" }: FabricPanelProps) {
  const [open, setOpen] = useState(true);
  return (
    <Panel
      title="Fabric"
      className={`md:col-span-2 ${className}`}
      actions={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-accent"
        >
          {open ? "Close" : "Open"}
          <ChevronDownIcon className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
      }
    >
      {open ? (
        <p className="text-xs text-muted">
          {note?.trim() ||
            "No switch scrape. 200G QSFP / CX7 show on Network for each spark. Add sparks.json fabricNote for a local caption."}
        </p>
      ) : (
        <p className="text-[11px] text-muted">Closed — optional fabric note.</p>
      )}
    </Panel>
  );
}
