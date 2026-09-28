import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

/** Convert a YYYY-MM-DD string (or Date) to a Date at local midnight. */
function toDate(value: string | Date): Date {
  if (value instanceof Date) return new Date(value.getTime());
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Format a YYYY-MM-DD string / Date as Czech `d. m. Y` (e.g. `17. 8. 2026`). */
export function formatCzDate(value: string | Date): string {
  const d = toDate(value);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}

/** English weekday shortcuts with Monday first. */
const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Format as English day shortcut + Czech date, e.g. `Mon 17. 8. 2026`. */
export function formatCzDateWithDay(value: string | Date): string {
  const d = toDate(value);
  const day = DAY_ABBR[(d.getDay() + 6) % 7]; // getDay: 0=Sun → index Mon-first
  return `${day} ${formatCzDate(d)}`;
}

/** Weekday header labels with Monday first (Czech). */
const WEEKDAYS = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

const MONTHS = [
  "Leden", "Únor", "Březen", "Duben", "Květen", "Červen",
  "Červenec", "Srpen", "Září", "Říjen", "Listopad", "Prosinec",
];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  min?: string; // YYYY-MM-DD
  max?: string; // YYYY-MM-DD
  ariaLabel?: string;
}

/**
 * Lightweight native-free date picker. Calendar weeks start on Monday and
 * dates are shown in the Czech `d. m. Y` format. Value is kept as YYYY-MM-DD
 * so it plugs straight into the existing range state/API.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  ariaLabel,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => toDate(value || new Date()));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = toDate(value || new Date());

  const startOfWeek = (d: Date) => {
    const c = new Date(d);
    const day = c.getDay(); // 0 = Sun
    const diff = day === 0 ? 6 : day - 1; // shift to Monday
    c.setDate(c.getDate() - diff);
    c.setHours(0, 0, 0, 0);
    return c;
  };

  const inRange = (d: Date) => {
    if (min) {
      const m = toDate(min);
      if (d < m) return false;
    }
    if (max) {
      const m = toDate(max);
      if (d > m) return false;
    }
    return true;
  };

  // Build a 6-row grid of days starting Monday for the visible month.
  const firstOfMonth = new Date(view.getFullYear(), view.getMonth(), 1);
  const gridStart = startOfWeek(firstOfMonth);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }

  const prevMonth = () =>
    setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
  const nextMonth = () =>
    setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));

  const pick = (d: Date) => {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    onChange(local.toISOString().slice(0, 10));
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-border bg-surface-elevated px-2 py-1 font-tabular text-xs text-text outline-none transition-colors hover:border-accent focus:border-accent"
      >
        {formatCzDate(selected)}
      </button>

      {open && (
        <div className="absolute z-[10050] mt-1 w-60 rounded-lg border border-border bg-surface-elevated p-2 shadow-[var(--shadow-shell)]">
          {/* Header / month nav */}
          <div className="mb-1 flex items-center justify-between">
            <button
              type="button"
              onClick={prevMonth}
              aria-label="Previous month"
              className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              <ChevronLeftIcon className="h-3.5 w-3.5" />
            </button>
            <span className="text-xs font-semibold text-text-strong">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </span>
            <button
              type="button"
              onClick={nextMonth}
              aria-label="Next month"
              className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Weekday header (Monday first) */}
          <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase text-muted">
            {WEEKDAYS.map((w) => (
              <span key={w} className="py-0.5">
                {w}
              </span>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === view.getMonth();
              const isSel = isSameDay(d, selected);
              const isToday = isSameDay(d, new Date());
              const enabled = inRange(d);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!enabled}
                  onClick={() => pick(d)}
                  className={`h-7 rounded text-xs tabular-nums transition-colors ${
                    !inMonth
                      ? "text-muted/40"
                      : isSel
                        ? "bg-accent font-semibold text-text-strong"
                        : isToday
                          ? "bg-accent/15 text-accent"
                          : "text-text hover:bg-surface-hover"
                  } ${!enabled ? "cursor-not-allowed opacity-30" : ""}`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
