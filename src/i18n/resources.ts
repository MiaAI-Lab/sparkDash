import type { Resource } from "i18next";

// Translation catalogs live in src/locales/<locale>/<namespace>.json.
//
// There is intentionally NO `en` catalog: English defaults are written inline
// at the call site — t("shell.nav.overview", "Overview") — so the English text
// can never drift away from the code. Only locales that need translated
// strings ship JSON here (catalogs are nested, i18next's "." key separator
// turns "shell.nav.overview" into shell › nav › overview).
//
// Vite rewrites this glob at build time, so catalogs are bundled — no HTTP
// backend, no extra origin (the API lives on a different origin than the
// assets). A locale is fetched in one go the first time it is selected; the
// whole zh-Hans catalog is well under 60 KB of JSON (~15 KB gzipped) and only
// downloaded by users who actually chose Chinese.
const catalogModules = import.meta.glob("../locales/*/*.json");

interface CatalogPath {
  locale: string;
  namespace: string;
}

function parseCatalogPath(path: string): CatalogPath | null {
  const match = /^\.\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!match) return null;
  return { locale: match[1], namespace: match[2] };
}

function catalogEntries(): Array<CatalogPath & { load: () => Promise<unknown> }> {
  const entries: Array<CatalogPath & { load: () => Promise<unknown> }> = [];
  for (const [path, load] of Object.entries(catalogModules)) {
    const parsed = parseCatalogPath(path);
    if (parsed) entries.push({ ...parsed, load });
  }
  return entries;
}

/** Locales that ship at least one catalog file. */
export function catalogLocales(): string[] {
  return [...new Set(catalogEntries().map((entry) => entry.locale))].sort();
}

/** Namespaces shipped for one locale. */
export function catalogNamespaces(locale: string): string[] {
  return [
    ...new Set(
      catalogEntries()
        .filter((entry) => entry.locale === locale)
        .map((entry) => entry.namespace),
    ),
  ].sort();
}

/** Load every shipped namespace for one locale as i18next resource bundles. */
export async function loadLocaleCatalogs(locale: string): Promise<Record<string, Resource>> {
  const bundles: Record<string, Resource> = {};
  await Promise.all(
    catalogEntries()
      .filter((entry) => entry.locale === locale)
      .map(async (entry) => {
        const mod = (await entry.load()) as { default?: Resource } | Resource;
        const data = (mod && "default" in (mod as { default?: Resource })
          ? (mod as { default?: Resource }).default
          : mod) as Resource;
        bundles[entry.namespace] = data ?? {};
      }),
  );
  return bundles;
}
