#!/usr/bin/env node
/**
 * Translate missing zh-CN locale keys with any OpenAI-compatible endpoint.
 *
 * Designed for a local LM Studio serving Tencent's Hunyuan-MT (hy-mt2-7b),
 * which wants its official short instruction line directly before the text.
 * Any OpenAI-compatible server works (set I18N_BASE_URL / I18N_MODEL).
 *
 * Usage:
 *   node scripts/i18n-translate.mjs [--dry]
 *
 * Only keys present in locales/en.ts but missing from locales/zh-CN.ts are
 * translated; existing translations are never overwritten. Interpolation
 * placeholders ({{likeThis}}) are preserved verbatim.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EN_PATH = join(ROOT, "src/i18n/locales/en.ts");
const ZH_PATH = join(ROOT, "src/i18n/locales/zh-CN.ts");

const BASE_URL = process.env.I18N_BASE_URL || "http://192.168.30.69:1234/v1";
const MODEL = process.env.I18N_MODEL || "hy-mt2-7b";
const DRY = process.argv.includes("--dry");

// Extract `key: "value"` pairs of one top-level group from a locale TS file.
function extractGroup(source, group) {
  const start = source.indexOf(`${group}: {`);
  if (start < 0) return null;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let end = bodyStart;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(bodyStart + 1, end);
  const out = {};
  const re = /([a-zA-Z_0-9]+):\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2];
  return out;
}

async function translate(text) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: `把下面的文本翻译成中文，不要额外解释。\n\n${text}`,
        },
      ],
      max_tokens: 500,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  let out = (data.choices?.[0]?.message?.content || "").trim();
  // Keep i18next interpolation placeholders exactly as authored.
  const placeholders = text.match(/\{\{[^}]+\}\}/g) || [];
  placeholders.forEach((p, i) => {
    out = out.replace(new RegExp(`\\{\\{[^}]*\\}\\}(?:\\s*)?`.replace(/\{\{[^}]*\}\}/, i === 0 ? "{{" + p.slice(2) : "\\{\\{[^}]*\\}\\}")), p);
  });
  return out;
}

const enSrc = readFileSync(EN_PATH, "utf8");
const zhSrc = readFileSync(ZH_PATH, "utf8");
const groups = [...enSrc.matchAll(/^  ([a-zA-Z_0-9]+): \{/gm)].map((m) => m[1]);

const missing = [];
for (const group of groups) {
  const en = extractGroup(enSrc, group);
  const zh = extractGroup(zhSrc, group) || {};
  for (const key of Object.keys(en)) {
    if (!(key in zh)) missing.push({ group, key, text: en[key] });
  }
}

console.log(`${missing.length} key(s) to translate → ${MODEL} @ ${BASE_URL}`);
if (missing.length === 0) process.exit(0);
if (DRY) {
  missing.forEach((m) => console.log(`  [${m.group}.${m.key}] ${m.text}`));
  process.exit(0);
}

let updated = zhSrc;
for (const m of missing) {
  const zh = await translate(m.text);
  console.log(`  [${m.group}.${m.key}] ${m.text} → ${zh}`);
  // Insert after the group's opening line, in en.ts key order (append per group).
  const anchor = new RegExp(`(${m.group}: \\{\\n)`); // first missing key lands right after the brace
  if (!anchor.test(updated)) continue;
  updated = updated.replace(anchor, `$1    ${m.key}: ${JSON.stringify(zh)},\n`);
}

writeFileSync(ZH_PATH, updated);
console.log("zh-CN.ts updated. Review the diff, then rebuild the frontend.");
