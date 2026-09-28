import type { DayType } from "../../../shared/modelSchedules";

export interface RawWindow {
  start: string;
  end: string;
}

export interface ScheduleForm {
  enabled: boolean;
  weekday: RawWindow[];
  weekend: RawWindow[];
}

export const EMPTY_FORM: ScheduleForm = { enabled: false, weekday: [], weekend: [] };

export function normalize(v: string): string | null {
  const s = (v || "").trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(":").map(Number);
    if (h > 23 || m > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  if (/^\d{1,2}$/.test(s)) {
    const h = Number(s);
    if (h > 23) return null;
    return `${s.padStart(2, "0")}:00`;
  }
  // Compact 24-hour typing: "1800" → 18:00, "8" handled above, "800" → 08:00.
  if (/^\d{3,4}$/.test(s)) {
    const t = s.padStart(4, "0");
    const h = Number(t.slice(0, 2));
    const m = Number(t.slice(2));
    if (h > 23 || m > 59) return null;
    return `${t.slice(0, 2)}:${t.slice(2)}`;
  }
  return null;
}

export function windowsMatch(a: RawWindow[], b: RawWindow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
  return true;
}

export function formsMatch(a: ScheduleForm, b: ScheduleForm): boolean {
  return a.enabled === b.enabled && windowsMatch(a.weekday, b.weekday) && windowsMatch(a.weekend, b.weekend);
}

const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MINS = 1440;
function parse(v: string): number | null {
  const m = CLOCK_RE.exec((v || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function overlaps(x: RawWindow, y: RawWindow): boolean {
  const spans = (w: RawWindow): [number, number][] => {
    const s = parse(w.start)!;
    const e = parse(w.end)!;
    if (s === e) return [[0, MINS]];
    return e <= s ? [[s, MINS], [0, e]] : [[s, e]];
  };
  for (const [a0, a1] of spans(x)) for (const [b0, b1] of spans(y)) if (a0 < b1 && b0 < a1) return true;
  return false;
}

/**
 * Client-side validation mirroring src/shared/modelSchedules.js. The server
 * always re-checks; this exists so the dialog can name the offending row
 * before a save round-trip. Boundary equality is not an overlap.
 */
export function validateForm(form: ScheduleForm): string[] {
  const errors: string[] = [];
  const dayTypes: DayType[] = ["weekday", "weekend"];
  for (const day of dayTypes) {
    const list = form[day];
    const parsed: { raw: RawWindow; start: number; end: number }[] = [];
    list.forEach((w, i) => {
      const s = parse(w.start);
      const e = parse(w.end);
      const label = `${day === "weekday" ? "Weekday" : "Weekend"} window ${i + 1}`;
      if (s == null || e == null) {
        errors.push(`${label}: both times must be valid 24-hour HH:MM (minute precision).`);
        return;
      }
      parsed.push({ raw: w, start: s, end: e });
    });
    for (let i = 0; i < parsed.length; i += 1) {
      for (let j = i + 1; j < parsed.length; j += 1) {
        if (overlaps(parsed[i].raw, parsed[j].raw)) {
          errors.push(
            `${day === "weekday" ? "Weekday" : "Weekend"}: ${parsed[i].raw.start}–${parsed[i].raw.end} overlaps ${parsed[j].raw.start}–${parsed[j].raw.end}.`
          );
        }
      }
    }
  }
  return errors;
}
