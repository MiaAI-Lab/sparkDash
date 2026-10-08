import { BenchIcon } from "../bench/BenchIcon";
import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SparkSnapshot } from "../../api/types";
import { ACTIVITY_ID, ENERGY_ID, OVERVIEW_ID, TOKENS_ID } from "../../constants";
import { BENCH_TYPES } from "../bench/benchCatalog";
import { BoltIcon, ChevronDownIcon, EditIcon, GearIcon, GlobeIcon, GridIcon, ListIcon, PanelLeftIcon, PlusIcon, SearchIcon, TerminalIcon, TokensIcon, XLogoIcon } from "../ui/icons";
import { ThemeSwitch } from "../ThemeSwitch";
import { isThrottling, openShowcase, railSubLabel, showcaseTarget } from "./sparkSummary";

interface AppSidebarProps {
  sparks: SparkSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  /** Benchmark type whose page is showing, if any. */
  benchType?: string | null;
  onSelectBench?: (type: string) => void;
  connected: boolean;
  /** Poll interval in ms for the footer caption. */
  refreshInterval?: number | null;
  /** Hide the sidebar (a strip with a show button stays behind). */
  onCollapse?: () => void;
}

function dotClass(spark: SparkSnapshot): string {
  if (!spark.online) return "sdot sdot--off";
  if (isThrottling(spark)) return "sdot sdot--warn";
  return "sdot";
}

function RailSpark({
  spark,
  isActive,
  onSelect,
  onEdit,
}: {
  spark: SparkSnapshot;
  isActive: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: spark.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.6 : 1 }}
      className={`rail-item ${isActive ? "is-active" : ""}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-0 text-left text-inherit"
        onClick={() => onSelect(spark.id)}
        onDoubleClick={() => onEdit(spark.id)}
        aria-current={isActive ? "page" : undefined}
        aria-roledescription="sortable"
        title={`${spark.name}${spark.online ? "" : " (offline)"}. Drag to reorder.`}
      >
        <i className={dotClass(spark)} aria-hidden />
        <span className="rail-item__name">{spark.name}</span>
      </button>
      <span className="rail-item__sub">{railSubLabel(spark)}</span>
      <span className="rail-item__tools">
        <button
          type="button"
          className="rail-tool"
          title={`Edit ${spark.name}`}
          aria-label={`Edit ${spark.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onEdit(spark.id)}
        >
          <EditIcon className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
}

/** Left fleet rail: brand, workspace links, reorderable Spark list, settings and live-link status. */
export function AppSidebar({
  sparks,
  activeId,
  onSelect,
  onAdd,
  onEdit,
  onReorder,
  onOpenSettings,
  onOpenSearch,
  benchType = null,
  onSelectBench,
  connected,
  refreshInterval,
  onCollapse,
}: AppSidebarProps) {
  const [items, setItems] = useState<string[]>(() => sparks.map((s) => s.id));
  const [dragging, setDragging] = useState(false);
  const [benchOpen, setBenchOpen] = useState(() => {
    try {
      return localStorage.getItem("sparkdash.sidebar.benchOpen") !== "0";
    } catch {
      return true;
    }
  });
  const toggleBench = () =>
    setBenchOpen((open) => {
      try {
        localStorage.setItem("sparkdash.sidebar.benchOpen", open ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !open;
    });

  useEffect(() => {
    if (dragging) return;
    setItems(sparks.map((s) => s.id));
  }, [sparks, dragging]);

  const byId = useMemo(() => new Map(sparks.map((s) => [s.id, s])), [sparks]);
  const ordered = items.map((id) => byId.get(id)).filter(Boolean) as SparkSnapshot[];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const canReorder = Boolean(onReorder) && sparks.length > 1;
  const showcase = showcaseTarget(sparks);

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.indexOf(String(active.id));
    const to = items.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(items, from, to);
    setItems(next);
    onReorder?.(next);
  };

  return (
    <aside className="app-side" aria-label="Fleet navigation">
      <div className="side-head">
        <button type="button" className="brand" onClick={() => onSelect(OVERVIEW_ID)} aria-label="sparkDash overview">
          <span className="brand__mark">
            <BoltIcon className="h-[17px] w-[17px]" />
          </span>
          <span>
            spark<span className="brand__dash">Dash</span>
          </span>
        </button>
        {onCollapse ? (
          <button type="button" className="icon-circle side-toggle" onClick={onCollapse} title="Hide sidebar (Ctrl+B)" aria-label="Hide sidebar">
            <PanelLeftIcon className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="side-tools">
        <button type="button" className="search-trigger" onClick={onOpenSearch} aria-label="Open command palette">
          <SearchIcon className="h-4 w-4 shrink-0" />
          <span>Jump to…</span>
          <span className="kbd">Ctrl K</span>
        </button>
      </div>

      <div className="min-h-0">
        <div className="rail-label">
          <span>Sparks</span>
          <button type="button" onClick={onAdd} title="Add Spark / GPU host" aria-label="Add Spark or GPU host">
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {canReorder ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => setDragging(true)}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDragging(false)}
          >
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              <nav className="rail-list" aria-label="Sparks">
                {ordered.map((s) => (
                  <RailSpark key={s.id} spark={s} isActive={activeId === s.id} onSelect={onSelect} onEdit={onEdit} />
                ))}
              </nav>
            </SortableContext>
          </DndContext>
        ) : (
          <nav className="rail-list" aria-label="Sparks">
            {sparks.map((s) => (
              <div key={s.id} className={`rail-item ${activeId === s.id ? "is-active" : ""}`}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-0 text-left text-inherit"
                  onClick={() => onSelect(s.id)}
                  onDoubleClick={() => onEdit(s.id)}
                  aria-current={activeId === s.id ? "page" : undefined}
                >
                  <i className={dotClass(s)} aria-hidden />
                  <span className="rail-item__name">{s.name}</span>
                </button>
                <span className="rail-item__sub">{railSubLabel(s)}</span>
                <span className="rail-item__tools">
                  <button type="button" className="rail-tool" aria-label={`Edit ${s.name}`} onClick={() => onEdit(s.id)}>
                    <EditIcon className="h-3 w-3" />
                  </button>
                </span>
              </div>
            ))}
          </nav>
        )}
        {sparks.length === 0 ? (
          <p className="px-2.5 pt-1 text-xs text-muted">No Sparks yet. Use + to add one.</p>
        ) : null}
      </div>

      <div>
        <div className="rail-label">Workspace</div>
        <nav className="rail-list">
          <button
            type="button"
            className={`rail-item ${activeId === OVERVIEW_ID ? "is-active" : ""}`}
            onClick={() => onSelect(OVERVIEW_ID)}
            aria-current={activeId === OVERVIEW_ID ? "page" : undefined}
          >
            <GridIcon className="h-4 w-4" />
            <span className="rail-item__name">Overview</span>
          </button>
          <button
            type="button"
            className={`rail-item ${activeId === TOKENS_ID ? "is-active" : ""}`}
            onClick={() => onSelect(TOKENS_ID)}
            aria-current={activeId === TOKENS_ID ? "page" : undefined}
          >
            <TokensIcon className="h-4 w-4" />
            <span className="rail-item__name">Token totals</span>
          </button>
          <button
            type="button"
            className={`rail-item ${activeId === ENERGY_ID ? "is-active" : ""}`}
            onClick={() => onSelect(ENERGY_ID)}
            aria-current={activeId === ENERGY_ID ? "page" : undefined}
          >
            <BoltIcon className="h-4 w-4" />
            <span className="rail-item__name">Fleet energy</span>
          </button>
          <button
            type="button"
            className={`rail-item ${activeId === ACTIVITY_ID ? "is-active" : ""}`}
            onClick={() => onSelect(ACTIVITY_ID)}
            aria-current={activeId === ACTIVITY_ID ? "page" : undefined}
          >
            <ListIcon className="h-4 w-4" />
            <span className="rail-item__name">Activity</span>
          </button>
          <button
            type="button"
            className="rail-item disabled:opacity-50"
            disabled={!showcase}
            onClick={() => showcase && openShowcase(showcase)}
            title={showcase ? `Open the prompt showcase on ${showcase.name}` : "Needs an online Spark with a reachable LLM"}
          >
            <TerminalIcon className="h-4 w-4" />
            <span className="rail-item__name">Showcase</span>
          </button>
        </nav>
      </div>

      {onSelectBench ? (
        <div>
          <button
            type="button"
            className="rail-label rail-label--toggle"
            onClick={toggleBench}
            aria-expanded={benchOpen || benchType != null}
            aria-controls="rail-benchmarks"
          >
            <span>Benchmarks</span>
            <ChevronDownIcon className={`h-3 w-3 transition-transform ${benchOpen || benchType != null ? "" : "-rotate-90"}`} />
          </button>
          <nav className="rail-list" id="rail-benchmarks" aria-label="Benchmarks" hidden={!(benchOpen || benchType != null)}>
            {BENCH_TYPES.map((b) => (
              <div key={b.id}>
                <button
                  type="button"
                  className={`rail-item rail-item--compact ${benchType === b.id ? "is-active" : ""}`}
                  onClick={() => onSelectBench(b.id)}
                  aria-current={benchType === b.id ? "page" : undefined}
                  title={b.blurb}
                >
                  <BenchIcon id={b.id} className="h-3.5 w-3.5" />
                  <span className="rail-item__name">{b.label}</span>
                </button>
              </div>
            ))}
          </nav>
        </div>
      ) : null}

      <div className="rail-foot">
        <div className="rail-settings">
          <nav className="rail-list">
            <button type="button" className="rail-item" onClick={onOpenSettings}>
              <GearIcon className="h-4 w-4" />
              <span className="rail-item__name">Settings</span>
            </button>
          </nav>
          <ThemeSwitch />
        </div>
        <div className="rail-conn" role="status">
          <i className={`sdot ${connected ? "" : "sdot--warn"}`} aria-hidden />
          <span>{connected ? `Live${refreshInterval ? ` · ${Math.round(refreshInterval / 100) / 10} s poll` : ""}` : "Reconnecting…"}</span>
        </div>
        <div className="rail-credit">
          <span>by Mia&apos;s AI Lab</span>
          <span className="rail-credit__links">
            <a href="https://mia-ai.net/" target="_blank" rel="noopener noreferrer" title="Mia's AI Lab website" aria-label="Mia's AI Lab website">
              <GlobeIcon className="h-3.5 w-3.5" />
            </a>
            <a href="https://x.com/MiaAI_lab" target="_blank" rel="noopener noreferrer" title="Mia's AI Lab on X" aria-label="Mia's AI Lab on X">
              <XLogoIcon className="h-3 w-3" />
            </a>
          </span>
        </div>
      </div>
    </aside>
  );
}
