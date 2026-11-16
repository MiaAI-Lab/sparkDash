import type { ClipboardLimits } from "../../api/clipboardClient";

export type LimitProblem =
  | { kind: "textTooLarge"; limit: number }
  | { kind: "tooManyParts"; limit: number }
  | { kind: "partTooLarge"; name: string; limit: number }
  | { kind: "entryTooLarge"; limit: number };

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function checkTextLimit(text: string, limits: ClipboardLimits | null): LimitProblem | null {
  if (!limits) return null;
  return utf8Bytes(text) > limits.maxTextBytes ? { kind: "textTooLarge", limit: limits.maxTextBytes } : null;
}

export function checkFilesLimit(files: readonly File[], limits: ClipboardLimits | null): LimitProblem | null {
  if (!limits) return null;
  if (files.length > limits.maxParts) return { kind: "tooManyParts", limit: limits.maxParts };
  const big = files.find((f) => f.size > limits.maxPartBytes);
  if (big) return { kind: "partTooLarge", name: big.name, limit: limits.maxPartBytes };
  const total = files.reduce((sum, f) => sum + f.size, 0);
  return total > limits.maxEntryBytes ? { kind: "entryTooLarge", limit: limits.maxEntryBytes } : null;
}

export function entryTypeFor(files: readonly File[]): "image" | "files" {
  return files.length === 1 && files[0].type.startsWith("image/") ? "image" : "files";
}

export type Ago = { unit: "now" } | { unit: "min" | "hour" | "day"; count: number };

export function agoOf(ms: number, nowMs: number): Ago {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return { unit: "now" };
  const m = Math.round(s / 60);
  if (m < 60) return { unit: "min", count: m };
  const h = Math.round(m / 60);
  if (h < 48) return { unit: "hour", count: h };
  return { unit: "day", count: Math.round(h / 24) };
}

/** Files on a paste or drop event; pasted screenshots arrive as items with no entry in `files` in some browsers. */
export function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const direct = Array.from(data.files ?? []);
  if (direct.length) return direct;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

/** Fallback for contexts without the async clipboard API (plain http on a LAN address). */
export function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "cb-offscreen";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
