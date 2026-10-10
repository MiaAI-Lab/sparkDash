#!/usr/bin/env node
// i18n key checker for sparkDash.
//
// This repo has no ESLint (and no linter config at all), so the usual
// "no-untranslated-strings" lint rule cannot be used. This script takes its
// place: it scans the source for translation calls and cross-checks them
// against the shipped catalogs.
//
// Rules, by severity:
//   error  t("key") without an inline English default — English must always be
//          readable straight from the source. Use t("key", "English default").
//   error  an inline default that uses i18next-style {{name}} interpolation —
//          the ICU plugin (i18next-icu) only understands {name}.
//   error  a placeholder ({name}, {count, plural, …}) that is present in the
//          English default but missing from a translation, or vice versa.
//   warn   a key used in the source that has no translation in a catalog.
//   warn   a catalog key that is no longer used anywhere (orphan).
//   info   dynamic calls (t(variable), t(`key${x}`)) that cannot be verified.
//
// Usage:
//   node scripts/i18n-check.mjs            # errors fail, warnings are listed
//   node scripts/i18n-check.mjs --strict   # warnings fail too (for CI later)

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const LOCALES = path.join(SRC, "locales");
const I18N_ENTRY = path.join(SRC, "i18n", "index.ts");
const STRICT = process.argv.includes("--strict");

const errors = [];
const warnings = [];
const dynamicCalls = [];

function fail(message) {
  errors.push(message);
}
function warn(message) {
  warnings.push(message);
}

async function listSourceFiles() {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((file) => /\.(ts|tsx|js|jsx)$/.test(file))
    .filter((file) => !/\.test\.(ts|tsx|js|jsx)$/.test(file))
    .filter((file) => !file.startsWith(LOCALES + path.sep))
    .filter((file) => !file.startsWith(path.join(SRC, "i18n") + path.sep));
}

async function readNamespaces() {
  const text = await readFile(I18N_ENTRY, "utf8");
  const block = /const NAMESPACES = \[([\s\S]*?)\]/.exec(text);
  if (!block) {
    fail(`could not read the namespace list from ${path.relative(ROOT, I18N_ENTRY)}`);
    return [];
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function placeholders(text) {
  const found = new Set();
  for (const match of text.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)) found.add(match[1]);
  return found;
}

/** Collect translation calls from one file. */
function scanFile(relPath, text, used, defaults) {
  const lineOf = (index) => text.slice(0, index).split("\n").length;

  // t("key", …) / i18next.t("key", …) — capture the first argument and whether
  // a default follows.
  const callPattern = /(?:(?<![\w$.])|(?<=i18next\.))t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,?/g;
  for (const match of text.matchAll(callPattern)) {
    const key = match[1] ?? match[2];
    const after = match.index + match[0].length;
    const hasComma = match[0].trimEnd().endsWith(",");
    const location = `${relPath}:${lineOf(match.index)}`;
    if (!hasComma) {
      fail(`${location}: t("${key}") has no inline English default — use t("${key}", "English text")`);
      used.set(key, location);
      continue;
    }
    const rest = text.slice(after);
    const trimmed = rest.replace(/^\s+/, "");
    const next = trimmed[0];
    let defaultText;
    if (next === '"' || next === "'") {
      // Read to the closing quote, honouring backslash escapes. (Slicing to the
      // index of the quote search-hit would eat the character before it and drop
      // the trailing "}" of a default that ends in a placeholder.)
      const quote = next;
      let i = 1;
      let out = "";
      while (i < trimmed.length) {
        const ch = trimmed[i];
        if (ch === "\\") {
          out += ch + (trimmed[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (ch === quote) break;
        out += ch;
        i += 1;
      }
      defaultText = out;
    } else if (next === "`") {
      const literal = rest.slice(rest.indexOf("`") + 1);
      defaultText = literal.slice(0, literal.indexOf("`"));
    } else if (next === "{") {
      const body = balancedBraces(rest);
      const inline = /defaultValue\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(body);
      defaultText = inline ? inline[1] ?? inline[2] : undefined;
      if (defaultText === undefined && /\bdefaultValue\s*:/.test(body)) {
        dynamicCalls.push(`${location}: t("${key}", { defaultValue: <expression> })`);
      }
    }
    if (defaultText === undefined) {
      fail(`${location}: t("${key}") has no inline English default — use t("${key}", "English text")`);
    } else if (defaultText.includes("{{")) {
      fail(`${location}: t("${key}") default uses {{…}} — the ICU plugin needs single braces: {name}`);
    } else {
      const names = [...placeholders(defaultText)].sort();
      if (names.length > 0) defaults.set(key, { placeholders: names, location });
    }
    used.set(key, location);
  }

  // Static template literal keys: t(`shell.nav.overview`, "Overview")
  for (const match of text.matchAll(/(?:(?<![\w$.])|(?<=i18next\.))t\(\s*`([^`$]*)`/g)) {
    used.set(match[1], `${relPath}:${lineOf(match.index)}`);
  }

  // Dynamic keys we cannot verify.
  for (const match of text.matchAll(/(?:(?<![\w$.])|(?<=i18next\.))t\(\s*(?:`[^`]*\$\{|[A-Za-z_$][\w$.]*)/g)) {
    dynamicCalls.push(`${relPath}:${lineOf(match.index)}`);
  }

  // <Trans i18nKey="key"> — the English default lives in the JSX children.
  for (const match of text.matchAll(/i18nKey\s*=\s*\{?\s*(?:"([^"]+)"|'([^']+)')/g)) {
    used.set(match[1] ?? match[2], `${relPath}:${lineOf(match.index)}`);
  }
}

/** Text between the first "{" and its matching "}". */
function balancedBraces(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return text;
}

async function readCatalogs(namespaces) {
  const catalogs = new Map();
  let locales;
  try {
    locales = (await readdir(LOCALES, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return catalogs;
  }
  for (const locale of locales) {
    const flat = new Map();
    const dir = path.join(LOCALES, locale.name);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const namespace = entry.name.replace(/\.json$/, "");
      if (!namespaces.includes(namespace)) {
        warn(`${path.relative(ROOT, path.join(dir, entry.name))}: unknown namespace "${namespace}"`);
      }
      const data = JSON.parse(await readFile(path.join(dir, entry.name), "utf8"));
      // Keys are compared with their namespace prefix because that is how they
      // are written in the source: shell.json → nav.overview becomes
      // "shell.nav.overview".
      collectFlat(data, namespace, (key, value) => {
        flat.set(key, { value, file: path.join(dir, entry.name) });
      });
    }
    catalogs.set(locale.name, flat);
  }
  return catalogs;
}

function collectFlat(value, prefix, emit) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) collectFlat(child, prefix ? `${prefix}.${key}` : key, emit);
    return;
  }
  emit(prefix, value == null ? "" : String(value));
}

async function main() {
  const namespaces = await readNamespaces();
  const files = await listSourceFiles();
  /** @type {Map<string, string>} key → "file:line" where it is used */
  const used = new Map();
  /** @type {Map<string, {placeholders: string[], location: string}>} */
  const defaults = new Map();

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    scanFile(rel, text, used, defaults);
  }

  const catalogs = await readCatalogs(namespaces);
  const keyList = [...used.keys()].sort();

  for (const [locale, flat] of catalogs) {
    for (const key of keyList) {
      const entry = flat.get(key);
      if (!entry) {
        warn(`${locale}: missing translation for "${key}" (used in ${used.get(key)})`);
        continue;
      }
      const expected = defaults.get(key)?.placeholders;
      if (!expected || expected.length === 0) continue;
      const actual = [...placeholders(entry.value)].sort();
      const missing = expected.filter((name) => !actual.includes(name));
      const extra = actual.filter((name) => !expected.includes(name));
      if (missing.length || extra.length) {
        fail(
          `${locale}: "${key}" placeholder mismatch in ${path.relative(ROOT, entry.file)} — ` +
            `default has [${expected.join(", ")}]` +
            (missing.length ? `, translation is missing [${missing.join(", ")}]` : "") +
            (extra.length ? `, translation has extra [${extra.join(", ")}]` : ""),
        );
      }
    }
    for (const key of flat.keys()) {
      if (!used.has(key)) warn(`${locale}: orphan translation "${key}" is not used in the source`);
    }
  }

  const localeNames = [...catalogs.keys()];
  console.log(`i18n-check: ${files.length} source files, ${keyList.length} keys, catalogs: ${localeNames.join(", ") || "none"}`);
  console.log(`  namespaces: ${namespaces.join(", ")}`);
  console.log(`  errors: ${errors.length}, warnings: ${warnings.length}, dynamic calls: ${dynamicCalls.length}`);
  for (const message of errors) console.log(`  ERROR ${message}`);
  for (const message of warnings) console.log(`  WARN  ${message}`);
  if (dynamicCalls.length > 0) {
    console.log(`  INFO  ${dynamicCalls.length} dynamic t() call(s) cannot be verified:`);
    for (const message of dynamicCalls.slice(0, 20)) console.log(`        ${message}`);
    if (dynamicCalls.length > 20) console.log(`        … ${dynamicCalls.length - 20} more`);
  }

  if (errors.length > 0 || (STRICT && warnings.length > 0)) process.exit(1);
}

await main();
