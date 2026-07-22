import { memo, useEffect, useMemo, useState, useRef, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SparkSnapshot } from "../api/types";
import { PlusIcon, GridIcon } from "./ui/icons";
import { OVERVIEW_ID } from "../constants";

interface SparkTabsProps {
  sparks: SparkSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit?: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
}

function GripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden className="opacity-50">
      <circle cx="4" cy="3" r="1" />
      <circle cx="8" cy="3" r="1" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="8" cy="6" r="1" />
      <circle cx="4" cy="9" r="1" />
      <circle cx="8" cy="9" r="1" />
    </svg>
  );
}

/* ─── Mobile helpers ──────────────────────────────────── */

const MOBILE_BREAKPOINT = 768;

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);

  useEffect(() => {
    let ticking = false;
    const handler = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return isMobile;
}

function HamburgerIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

/**
 * Label + online-dot only. Memoized on primitives (#8a) so 2s WS frames that
 * rebuild the parent `spark` object do not reconcile the label. The drag
 * handle stays *outside* this memo so useSortable's fresh listeners/ref always
 * attach (excluding dragHandleProps from a whole-pill memo was stale-risk).
 */
const TabLabelButton = memo(
  function TabLabelButton({
    id,
    name,
    online,
    onSelect,
    onEdit,
  }: {
    id: string;
    name: string;
    online: boolean;
    onSelect: (id: string) => void;
    onEdit?: (id: string) => void;
  }) {
    return (
      <button
        type="button"
        onClick={() => onSelect(id)}
        onDoubleClick={() => onEdit?.(id)}
        className="pill-label"
      >
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            online ? "bg-success" : "bg-danger"
          }`}
        />
        {name}
      </button>
    );
  },
  (prev, next) =>
    prev.id === next.id &&
    prev.name === next.name &&
    prev.online === next.online &&
    prev.onSelect === next.onSelect &&
    prev.onEdit === next.onEdit
);

/**
 * Pill-nav tab item. When reorderable, a dedicated grip handle starts the
 * drag; clicking the label selects. Active = dark pill (via .pill-item-with-handle).
 * Not memoized as a whole — shell classes (active/drag/overlay) and handle props
 * must update every SortableTab render.
 */
function TabChrome({
  spark,
  isActive,
  onSelect,
  onEdit,
  dragHandleProps,
  isDragging,
  isOverlay,
}: {
  spark: SparkSnapshot;
  isActive: boolean;
  onSelect: (id: string) => void;
  onEdit?: (id: string) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement> & { ref?: (el: HTMLButtonElement | null) => void };
  isDragging?: boolean;
  isOverlay?: boolean;
}) {
  return (
    <div
      className={[
        "pill-item-with-handle shrink-0",
        isActive ? "is-active" : "",
        isOverlay ? "shadow-lg ring-1 ring-border scale-[1.03]" : "",
        isDragging && !isOverlay ? "opacity-40" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className="pill-handle"
        title="Drag to reorder"
        aria-label={`Reorder ${spark.name}`}
        {...dragHandleProps}
      >
        <GripIcon />
      </button>
      <TabLabelButton
        id={spark.id}
        name={spark.name}
        online={spark.online}
        onSelect={onSelect}
        onEdit={onEdit}
      />
    </div>
  );
}

function SortableTab({
  spark,
  isActive,
  onSelect,
  onEdit,
}: {
  spark: SparkSnapshot;
  isActive: boolean;
  onSelect: (id: string) => void;
  onEdit?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: spark.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="shrink-0">
      <TabChrome
        spark={spark}
        isActive={isActive}
        onSelect={onSelect}
        onEdit={onEdit}
        isDragging={isDragging}
        dragHandleProps={{
          ref: setActivatorNodeRef,
          ...attributes,
          ...listeners,
        }}
      />
    </div>
  );
}

export function SparkTabs({
  sparks,
  activeId,
  onSelect,
  onAdd,
  onEdit,
  onReorder,
}: SparkTabsProps) {
  const [items, setItems] = useState<string[]>(() => sparks.map((s) => s.id));
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false);
  }, [isMobile]);

  useEffect(() => {
    const ids = sparks.map((s) => s.id);
    setItems((prev) => {
      const same =
        prev.length === ids.length &&
        prev.every((id) => ids.includes(id)) &&
        ids.every((id) => prev.includes(id));
      if (!same) return ids;
      if (!activeDragId && prev.join("\0") !== ids.join("\0")) return ids;
      return prev;
    });
  }, [sparks, activeDragId]);

  const byId = useMemo(() => new Map(sparks.map((s) => [s.id, s])), [sparks]);
  const ordered = items.map((id) => byId.get(id)).filter(Boolean) as SparkSnapshot[];
  const activeDragSpark = activeDragId ? byId.get(activeDragId) : null;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const canReorder = Boolean(onReorder) && sparks.length > 1;

  // ── Mobile: hamburger + dropdown ────────────────────
  if (isMobile) {
    return (
      <div className="mobile-menu-wrapper">
        <button
          type="button"
          className="icon-circle"
          onClick={() => setMobileMenuOpen((v) => !v)}
          aria-label="Select Spark"
          title="Select Spark"
        >
          <HamburgerIcon className="h-4 w-4" />
        </button>
        <MobileSparkMenu
          sparks={sparks}
          activeId={activeId}
          onSelect={onSelect}
          onAdd={onAdd}
          isOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
        />
      </div>
    );
  }

  // ── Desktop: pill-nav ───────────────────────────────

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over || active.id === over.id) return;

    setItems((prev) => {
      const oldIndex = prev.indexOf(String(active.id));
      const newIndex = prev.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      onReorder?.(next);
      return next;
    });
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
  };

  if (!canReorder) {
    return (
      <nav className="pill-nav" aria-label="Sparks">
        <OverviewTab isActive={activeId === OVERVIEW_ID} onSelect={onSelect} />
        {sparks.map((spark) => (
          <div key={spark.id} className="shrink-0">
            <TabChrome
              spark={spark}
              isActive={activeId === spark.id}
              onSelect={onSelect}
              onEdit={onEdit}
            />
          </div>
        ))}
        <AddButton onAdd={onAdd} />
      </nav>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <nav className="pill-nav" aria-label="Sparks">
        <OverviewTab isActive={activeId === OVERVIEW_ID} onSelect={onSelect} />
        <SortableContext items={items} strategy={horizontalListSortingStrategy}>
          {ordered.map((spark) => (
            <SortableTab
              key={spark.id}
              spark={spark}
              isActive={activeId === spark.id}
              onSelect={onSelect}
              onEdit={onEdit}
            />
          ))}
        </SortableContext>
        <AddButton onAdd={onAdd} />
      </nav>

      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)" }}>
        {activeDragSpark ? (
          <TabChrome
            spark={activeDragSpark}
            isActive={activeId === activeDragSpark.id}
            onSelect={() => {}}
            isOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function AddButton({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      title="Add Spark"
      aria-label="Add Spark"
      className="pill-add shrink-0"
    >
      <PlusIcon className="h-3.5 w-3.5" />
    </button>
  );
}

function OverviewTab({
  isActive,
  onSelect,
}: {
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => onSelect(OVERVIEW_ID)}
        className={`pill-item ${isActive ? "is-active" : ""}`}
      >
        <GridIcon className="h-3.5 w-3.5" />
        Overview
      </button>
    </div>
  );
}

/* ─── Mobile dropdown menu ────────────────────────────── */

function MobileSparkMenu({
  sparks,
  activeId,
  onSelect,
  onAdd,
  isOpen,
  onClose,
}: {
  sparks: SparkSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  isOpen: boolean;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  const handleItemClick = useCallback(
    (id: string) => {
      onSelect(id);
      onClose();
    },
    [onSelect, onClose]
  );

  const handleAddClick = useCallback(() => {
    onAdd();
    onClose();
  }, [onAdd, onClose]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer to avoid the click that just opened the menu
    const id = setTimeout(() => document.addEventListener("click", handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", handler);
    };
  }, [isOpen, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div ref={menuRef} className="mobile-spark-menu" role="menu">
      <button
        type="button"
        role="menuitem"
        className={`mobile-menu-item ${activeId === OVERVIEW_ID ? "is-active" : ""}`}
        onClick={() => handleItemClick(OVERVIEW_ID)}
      >
        <GridIcon className="h-3.5 w-3.5" />
        Overview
      </button>
      {sparks.map((spark) => (
        <button
          key={spark.id}
          type="button"
          role="menuitem"
          className={`mobile-menu-item ${activeId === spark.id ? "is-active" : ""}`}
          onClick={() => handleItemClick(spark.id)}
        >
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              spark.online ? "bg-success" : "bg-danger"
            }`}
          />
          {spark.name}
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className="mobile-menu-item mobile-menu-add"
        onClick={handleAddClick}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Add Spark
      </button>
    </div>
  );
}