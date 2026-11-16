/** Client for the opt-in Shared clipboard (/api/clipboard). */
import { ApiError, apiFetch } from "./client";
import { authHeaders, reportAuthRequired } from "./authToken";

export type ClipboardEntryType = "text" | "image" | "files";

export interface ClipboardPart {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface ClipboardEntry {
  id: string;
  type: ClipboardEntryType;
  textSize: number;
  textPreview: string | null;
  textTruncated: boolean;
  parts: ClipboardPart[];
  size: number;
  contentKey: string;
  source: { kind: "browser" | "device"; device: string | null };
  createdAt: number;
}

export interface ClipboardLimits {
  maxEntries: number;
  maxTextBytes: number;
  maxPartBytes: number;
  maxParts: number;
  maxEntryBytes: number;
}

export interface ClipboardState {
  revision: number;
  latest: ClipboardEntry | null;
  limits: ClipboardLimits;
}

export interface ClipboardHistory {
  revision: number;
  entries: ClipboardEntry[];
}

export interface ClipboardUpload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

const BASE = "/api/clipboard";

function entryPath(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export function partPath(entryId: string, partId: string): string {
  return `${entryPath(entryId)}/parts/${encodeURIComponent(partId)}`;
}

export function fetchClipboard(): Promise<ClipboardState> {
  return apiFetch(BASE);
}

export function fetchClipboardHistory(): Promise<ClipboardHistory> {
  return apiFetch(`${BASE}/history`);
}

export function shareClipboardText(text: string): Promise<{ entry: ClipboardEntry; revision: number; duplicate?: boolean }> {
  return apiFetch(`${BASE}/text`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: text,
  });
}

export function uploadClipboardPart(file: Blob, name: string): Promise<{ upload: ClipboardUpload }> {
  return apiFetch(`${BASE}/uploads`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Clipboard-Name": encodeURIComponent(name),
    },
    body: file,
  });
}

export function createClipboardEntry(uploads: string[], type: "image" | "files"): Promise<{ entry: ClipboardEntry; revision: number }> {
  return apiFetch(BASE, { method: "POST", body: JSON.stringify({ uploads, type }) });
}

export function deleteClipboardEntry(id: string): Promise<{ removed: boolean; revision: number }> {
  return apiFetch(entryPath(id), { method: "DELETE" });
}

export function clearClipboard(): Promise<{ removed: number; revision: number }> {
  return apiFetch(BASE, { method: "DELETE" });
}

async function authedRaw(path: string): Promise<Response> {
  const res = await fetch(path, { headers: { ...authHeaders() } });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  }
  return res;
}

export async function fetchClipboardText(id: string): Promise<string> {
  return (await authedRaw(`${entryPath(id)}/text`)).text();
}

export async function fetchClipboardPart(entryId: string, partId: string): Promise<Blob> {
  return (await authedRaw(partPath(entryId, partId))).blob();
}
