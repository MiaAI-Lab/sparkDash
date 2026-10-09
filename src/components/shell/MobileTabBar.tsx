import { BenchIcon } from "../bench/BenchIcon";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useInertBackground } from "../../hooks/useInertBackground";
import type { SparkSnapshot } from "../../api/types";
import { ACTIVITY_ID, ENERGY_ID, OVERVIEW_ID, SHOWCASE_ID, TOKENS_ID, benchId, benchTypeOf, isPageId } from "../../constants";
import { BENCH_TYPES } from "../bench/benchCatalog";
import { BoltIcon, ChartIcon, GearIcon, GridIcon, ListIcon, PlusIcon, ServerIcon, TerminalIcon, TokensIcon } from "../ui/icons";
import { isThrottling, railSubLabel } from "./sparkSummary";
import { ShutdownAll } from "../ShutdownAll";

/** Keep in sync with the sheet-out animation in shell.css. */
const SHEET_LEAVE_MS = 240;

interface MobileTabBarProps {
  sparks: SparkSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onOpenSettings: () => void;
}

/** Floating bottom tab bar for narrow screens (the fleet rail is hidden there). */
export function MobileTabBar({ sparks, activeId, onSelect, onAdd, onOpenSettings }: MobileTabBarProps) {
  const [sheetKind, setSheetKind] = useState<"sparks" | "stats" | null>(null);
  const sheet = sheetKind != null;
  // Closing plays a slide-down first; the sheet unmounts when it has finished.
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const openSheet = (kind: "sparks" | "stats") => {
    clearTimeout(leaveTimer.current);
    setLeaving(false);
    setSheetKind(kind);
  };
  const setSheet = (open: boolean) => {
    if (open) return openSheet("sparks");
    if (leaving) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setSheetKind(null);
      return;
    }
    setLeaving(true);
    leaveTimer.current = setTimeout(() => {
      setSheetKind(null);
      setLeaving(false);
    }, SHEET_LEAVE_MS);
  };
  const trapRef = useFocusTrap(sheet);
  useInertBackground(sheet);
  const onSpark = activeId != null && !isPageId(activeId);
  // Escape closes the sheet, like every other dialog.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);
  // Which tab the sliding highlight sits under (-1 hides it, e.g. while on a Settings dialog).
  const statsActive = activeId === TOKENS_ID || activeId === ENERGY_ID || activeId === ACTIVITY_ID;
  const tabIndex =
    sheetKind === "sparks" ? 1 : sheetKind === "stats" ? 2 : activeId === OVERVIEW_ID ? 0 : onSpark ? 1 : statsActive ? 2 : -1;
  const pageButton = (id: string, label: string, icon: ReactNode, compact = false) => (
    <button
      key={id}
      type="button"
      className={`rail-item ${compact ? "rail-item--compact" : ""} ${activeId === id ? "is-active" : ""}`}
      onClick={() => {
        setSheet(false);
        onSelect(id);
      }}
    >
      {icon}
      <span className="rail-item__name">{label}</span>
    </button>
  );
  return (
    <>
      <nav className="tabbar" aria-label="Primary" data-tab={tabIndex}>
        <button type="button" className={tabIndex === 0 ? "is-active" : ""} aria-current={activeId === OVERVIEW_ID ? "page" : undefined} onClick={() => onSelect(OVERVIEW_ID)}>
          <GridIcon className="h-[18px] w-[18px]" />
          Overview
        </button>
        <button type="button" className={tabIndex === 1 ? "is-active" : ""} aria-current={onSpark ? "page" : undefined} onClick={() => setSheet(true)} aria-haspopup="dialog">
          <ServerIcon className="h-[18px] w-[18px]" />
          Sparks
        </button>
        <button
          type="button"
          className={tabIndex === 2 ? "is-active" : ""}
          aria-current={activeId === TOKENS_ID || activeId === ENERGY_ID || activeId === ACTIVITY_ID ? "page" : undefined}
          onClick={() => openSheet("stats")}
          aria-haspopup="dialog"
        >
          <ChartIcon className="h-[18px] w-[18px]" />
          Stats
        </button>
        <button type="button" onClick={onOpenSettings}>
          <GearIcon className="h-[18px] w-[18px]" />
          Settings
        </button>
      </nav>
      {sheet
        ? createPortal(
            <div
              className={`sheet-overlay ${leaving ? "is-leaving" : ""}`}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setSheet(false);
              }}
            >
              <div ref={trapRef} className={`sheet ${leaving ? "is-leaving" : ""}`} role="dialog" aria-modal="true" aria-label={sheetKind === "stats" ? "Stats" : "Choose a Spark"}>
                <div className="rail-list">
                  {sheetKind === "stats" ? (
                    ([
                      [TOKENS_ID, "Token totals", <TokensIcon key="t" className="h-4 w-4" />],
                      [ENERGY_ID, "Fleet energy", <BoltIcon key="e" className="h-4 w-4" />],
                      [ACTIVITY_ID, "Activity", <ListIcon key="a" className="h-4 w-4" />],
                    ] as const).map(([id, label, icon]) => pageButton(id, label, icon))
                  ) : (
                    <>
                  <div className="rail-label rail-label--spaced">
                    <span>Benchmarks</span>
                  </div>
                  {BENCH_TYPES.map((b) => (
                    <Fragment key={b.id}>
                      <button
                        type="button"
                        className={`rail-item rail-item--compact ${benchTypeOf(activeId) === b.id ? "is-active" : ""}`}
                        onClick={() => {
                          setSheet(false);
                          onSelect(benchId(b.id));
                        }}
                      >
                        <BenchIcon id={b.id} className="h-3.5 w-3.5" />
                        <span className="rail-item__name">{b.label}</span>
                      </button>
                      {b.id === "prefill"
                        ? pageButton(SHOWCASE_ID, "Showcase", <TerminalIcon className="h-3.5 w-3.5" />, true)
                        : null}
                    </Fragment>
                  ))}
                  <div className="rail-label rail-label--spaced">
                    <span>Sparks</span>
                  </div>
                  {sparks.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`rail-item ${activeId === s.id ? "is-active" : ""}`}
                      onClick={() => {
                        setSheet(false);
                        onSelect(s.id);
                      }}
                    >
                      <i className={`sdot ${!s.online ? "sdot--off" : isThrottling(s) ? "sdot--warn" : ""}`} aria-hidden />
                      <span className="rail-item__name">{s.name}</span>
                      <span className="rail-item__sub">{railSubLabel(s)}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="rail-item"
                    onClick={() => {
                      setSheet(false);
                      onAdd();
                    }}
                  >
                    <PlusIcon className="h-4 w-4" />
                    <span className="rail-item__name">Add Spark / GPU host</span>
                  </button>
                  <div className="rail-label rail-label--spaced">
                    <span>Fleet</span>
                  </div>
                  <div className="sheet-power">
                    <ShutdownAll sparks={sparks} className="sheet-power__btn" />
                  </div>
                    </>
                  )}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
