import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SearchIcon } from "../ui/icons";

export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  /** Right-aligned secondary text. */
  hint?: string;
  icon?: ReactNode;
  /** Extra words that should match the query. */
  keywords?: string;
  run: () => void;
}

/** Subsequence match with a small bonus for prefix / word-start hits. Returns -Infinity when there is no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 - direct - (direct === 0 ? 0 : t[direct - 1] === " " ? 0 : 10);
  let ti = 0;
  let score = 30;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -Infinity;
    score -= found - ti;
    ti = found + 1;
  }
  return score;
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query.trim()) return commands;
  return commands
    .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.label), fuzzyScore(query, `${c.group} ${c.keywords ?? ""}`) - 40) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

/** Jump-anywhere palette (Ctrl/⌘ K): Sparks, actions, settings. */
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setSel(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const run = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return createPortal(
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette__input">
          <SearchIcon className="h-4 w-4" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a Spark, run an action, open settings…"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette__list" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <div className="palette__empty">No match for “{query}”.</div>
          ) : (
            results.map((cmd, i) => {
              const header = cmd.group !== lastGroup ? cmd.group : null;
              lastGroup = cmd.group;
              return (
                <div key={cmd.id}>
                  {header ? <div className="palette__group">{header}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === sel}
                    data-idx={i}
                    className={`palette__item ${i === sel ? "is-sel" : ""}`}
                    onMouseMove={() => setSel(i)}
                    onClick={() => run(cmd)}
                  >
                    <span className="grid h-5 w-5 place-items-center text-muted">{cmd.icon}</span>
                    <span className="min-w-0 truncate">{cmd.label}</span>
                    {cmd.hint ? <small>{cmd.hint}</small> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="palette__foot">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
