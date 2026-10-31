import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useInertBackground } from "../../hooks/useInertBackground";
import { useTranslation } from "react-i18next";
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

const LIST_ID = "palette-list";
const optionId = (i: number) => `palette-option-${i}`;

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

/** Jump-anywhere palette (Ctrl/⌘ K): Sparks, actions, settings. */
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const { t } = useTranslation("shell");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trapRef = useFocusTrap(open);
  useInertBackground(open);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  // A locale change can shrink the results without changing the typed query.
  const selectedIndex = Math.max(0, Math.min(sel, results.length - 1));

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
    }
  }, [open]);

  useEffect(() => setSel(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIndex}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  const run = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // An IME is still composing (Enter confirms the candidate): leave every key to it.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.max(0, Math.min(results.length - 1, selectedIndex + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(0, selectedIndex - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[selectedIndex]);
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
      <div ref={trapRef} className="palette" role="dialog" aria-modal="true" aria-label={t("palette.dialogLabel")} onKeyDown={onKeyDown}>
        <div className="palette__input">
          <SearchIcon className="h-4 w-4" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.searchLabel")}
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? optionId(selectedIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="kbd">{t("palette.escapeKey")}</span>
        </div>
        <div className="palette__list" ref={listRef} role="listbox" id={LIST_ID} aria-label={t("palette.listLabel")}>
          {results.length === 0 ? (
            <div className="palette__empty">{t("palette.noMatch", { query })}</div>
          ) : (
            results.map((cmd, i) => {
              const header = cmd.group !== lastGroup ? cmd.group : null;
              lastGroup = cmd.group;
              return (
                <div key={cmd.id} role="presentation">
                  {header ? <div className="palette__group" role="presentation">{header}</div> : null}
                  {/* Options are not tab stops: the input keeps focus and points at the selected one. */}
                  <div
                    role="option"
                    id={optionId(i)}
                    aria-selected={i === selectedIndex}
                    data-idx={i}
                    className={`palette__item ${i === selectedIndex ? "is-sel" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => setSel(i)}
                    onClick={() => run(cmd)}
                  >
                    <span className="grid h-5 w-5 place-items-center text-muted">{cmd.icon}</span>
                    <span className="min-w-0 truncate">{cmd.label}</span>
                    {cmd.hint ? <small>{cmd.hint}</small> : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="palette__foot">
          <span>{t("palette.move")}</span>
          <span>{t("palette.open")}</span>
          <span>{t("palette.close")}</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
