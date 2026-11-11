import { useEffect, useState } from "react";
import { fetchStorageFolders } from "../../api/client";
import type { StorageFolders } from "../../api/types";
import { parentPath } from "./storageTree";
import { ChevronRightIcon, FolderIcon } from "../ui/icons";

interface FolderPickerProps {
  sparkId: string;
  /** The chosen folder, or "" when nothing is chosen yet. */
  value: string;
  onChange: (path: string) => void;
  /** Where to open when nothing is chosen yet. */
  startAt: string;
  disabled?: boolean;
}

/** "/a/b" -> [["a", "/a"], ["b", "/a/b"]] */
function crumbs(path: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/**
 * Choose a folder on the Spark by clicking through it: the folder that is open is the choice, so there is
 * nothing to type. The list has a fixed height so the page does not jump while a folder loads.
 */
export function FolderPicker({ sparkId, value, onChange, startAt, disabled = false }: FolderPickerProps) {
  const [at, setAt] = useState(value.startsWith("/") ? value : startAt);
  const [listing, setListing] = useState<StorageFolders | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    fetchStorageFolders(sparkId, at)
      .then((res) => {
        if (!current) return;
        setListing(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!current) return;
        setListing(null);
        setError(err instanceof Error ? err.message : "Could not open this folder");
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [sparkId, at]);

  // The open folder is the chosen one.
  useEffect(() => {
    if (at !== value) onChange(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  const up = parentPath(at);
  const open = (path: string) => {
    if (!disabled) setAt(path);
  };

  return (
    <div className="st-folderpicker">
      <nav className="st-picker__crumbs" aria-label="Folder path">
        <button type="button" className="st-picker__crumb" onClick={() => open("/")} disabled={disabled || at === "/"} aria-current={at === "/" ? "location" : undefined}>
          /
        </button>
        {crumbs(at).map((c, i, all) => (
          <span key={c.path} className="st-picker__crumbwrap">
            <ChevronRightIcon className="h-3 w-3" />
            <button type="button" className="st-picker__crumb" onClick={() => open(c.path)} disabled={disabled || i === all.length - 1} aria-current={i === all.length - 1 ? "location" : undefined}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      <ul className="st-picker__list" aria-label={`Folders in ${at}`} aria-busy={loading}>
        {up != null ? (
          <li>
            <button type="button" className="st-picker__row is-up" onClick={() => open(up)} disabled={disabled}>
              <span aria-hidden>↑</span> Up to {up === "/" ? "the top" : up.split("/").pop()}
            </button>
          </li>
        ) : null}
        {loading ? <li className="st-picker__note">Opening…</li> : null}
        {!loading && error ? <li className="st-picker__note is-warn">{error}</li> : null}
        {!loading && !error && listing && listing.dirs.length === 0 ? <li className="st-picker__note">No folders inside. Analyse this folder, or go up.</li> : null}
        {!loading && !error
          ? listing?.dirs.map((name) => (
              <li key={name}>
                <button type="button" className="st-picker__row" onClick={() => open(at === "/" ? `/${name}` : `${at}/${name}`)} disabled={disabled}>
                  <FolderIcon className="h-4 w-4 shrink-0" />
                  <span className="st-picker__name">{name}</span>
                  <ChevronRightIcon className="h-3 w-3 shrink-0" />
                </button>
              </li>
            ))
          : null}
        {!loading && !error && listing?.more ? <li className="st-picker__note">Only the first folders are shown. Open a parent folder to narrow it down.</li> : null}
      </ul>
      <p className="st-picker__chosen">
        Analyse this folder: <b className="mono">{at}</b>
      </p>
    </div>
  );
}
