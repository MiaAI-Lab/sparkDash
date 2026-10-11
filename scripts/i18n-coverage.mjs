#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";

const DISPLAY_ATTRIBUTES = new Set(["title", "aria-label", "aria-description", "alt", "placeholder", "label", "help", "description", "note", "caption", "emptyText", "loadingText", "errorText", "legend"]);
const DISPLAY_PROPERTIES = new Set(["label", "blurb", "title", "subtitle", "description", "help", "hint", "tooltip", "ask", "note", "caption", "emptyText", "loadingText", "errorText", "message", "recovery"]);
const TRANSLATION_CALLS = new Set(["t", "localizedText", "localizedMessage", "localizedHealth"]);
const words = value => /[A-Za-z]{2,}/.test(value);
const normalize = value => value.replace(/\s+/g, " ").trim();

/** Inspect syntax, rather than grep, so comments, code and CSS do not count as UI text. */
export function scanUiText(source, file) {
  const ast = parseAst(source, { lang: path.extname(file).slice(1) || "tsx" }, file);
  const findings = [];
  const seen = new Set();
  const add = (node, kind, text) => {
    text = normalize(text);
    if (!words(text) || seen.has(node.start)) return;
    seen.add(node.start);
    findings.push({ file, line: source.slice(0, node.start).split("\n").length, start: node.start, end: node.end, kind, text });
  };
  const literal = (node, kind) => {
    if (!node) return;
    if (node.type === "Literal" && typeof node.value === "string") add(node, kind, node.value);
    else if (node.type === "TemplateLiteral") {
      add(node, kind, node.quasis.map(q => q.value.cooked ?? q.value.raw).join("{…}"));
      // Conditional labels inside an interpolation also need translations.
      for (const expression of node.expressions) literal(expression, kind);
    } else if (node.type === "ConditionalExpression") {
      literal(node.consequent, kind); literal(node.alternate, kind);
    } else if (node.type === "LogicalExpression" || (node.type === "BinaryExpression" && node.operator === "+")) {
      literal(node.left, kind); literal(node.right, kind);
    } else if (node.type === "JSXExpressionContainer") literal(node.expression, kind);
    else if (node.type === "ArrayExpression") for (const item of node.elements) literal(item, kind);
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && ["join", "concat"].includes(node.callee.property.name)) literal(node.callee.object, kind);
  };
  const visit = (node, parent) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression") {
      const name = node.callee.name ?? node.callee.property?.name;
      if (TRANSLATION_CALLS.has(name)) return;
      if (/^(?:set\w*(?:Error|Warning|Notice)|alert|confirm)$/.test(name ?? "")) for (const arg of node.arguments) literal(arg, "feedback");
      if (node.callee.type === "Identifier" && node.callee.name === "Error") for (const arg of node.arguments) literal(arg, "error");
    }
    if (node.type === "NewExpression" && node.callee.name === "Error") for (const arg of node.arguments) literal(arg, "error");
    if (node.type === "JSXText") add(node, "jsx", node.value);
    if (node.type === "JSXAttribute" && DISPLAY_ATTRIBUTES.has(node.name.name)) literal(node.value, "attribute");
    if (node.type === "JSXExpressionContainer" && parent?.type !== "JSXAttribute") literal(node.expression, "expression");
    if (node.type === "Property" && !node.computed && DISPLAY_PROPERTIES.has(node.key.name ?? node.key.value)) literal(node.value, "property");
    if (node.type === "VariableDeclarator" && /^(?:label|title|subtitle|head|hint|lead|caption|emptyText|errorText|description|message)$/.test(node.id.name ?? "")) literal(node.init, "variable");
    if (node.type === "ReturnStatement") literal(node.argument, "return");
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc", "range", "comments", "raw"].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, node);
      } else if (value?.type) visit(value, node);
    }
  };
  visit(ast, null);
  return findings;
}

export function applyExceptions(findings, exceptions) {
  const key = x => JSON.stringify([x.file, x.kind, x.text]);
  const found = new Set(findings.map(key));
  const allowed = new Map();
  const errors = [];
  for (const item of exceptions) {
    if (!item.file || !item.kind || !item.text || !item.reason?.trim() || /[*?]/.test(item.file)) {
      errors.push("Every exception must name one exact file, syntax kind, text and reason; wildcard exceptions are forbidden."); continue;
    }
    if (allowed.has(key(item))) errors.push(`Duplicate exception: ${key(item)}`);
    if (!found.has(key(item))) errors.push(`Stale exception: ${key(item)}`);
    allowed.set(key(item), item.reason);
  }
  return { untranslated: findings.filter(x => !allowed.has(key(x))), errors, retained: findings.filter(x => allowed.has(key(x))) };
}

export async function collectUiText(root) {
  const entries = await readdir(path.join(root, "src"), { recursive: true, withFileTypes: true });
  const files = entries.filter(x => x.isFile()).map(x => path.join(x.parentPath ?? x.path, x.name))
    .filter(x => /\.[jt]sx?$/.test(x) && !/\.d\.ts$/.test(x) && !/\.test\.[jt]sx?$/.test(x) && !/[\\/]i18n[\\/]/.test(x) && !/[\\/]test[\\/]/.test(x));
  const findings = [];
  for (const file of files) findings.push(...scanUiText(await readFile(file, "utf8"), path.relative(root, file).split(path.sep).join("/")));
  return { files: files.length, findings };
}

async function main() {
  const root = process.cwd();
  const { files, findings } = await collectUiText(root);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(findings, null, 2)); return; }
  const exceptions = JSON.parse(await readFile(path.join(root, "scripts/i18n-retained-text.json"), "utf8"));
  const result = applyExceptions(findings, exceptions);
  console.log(`i18n-coverage: ${files} files, ${result.untranslated.length} untranslated candidates, ${result.retained.length} documented retained strings, ${result.errors.length} exception errors`);
  for (const item of result.untranslated) console.log(`  ${item.file}:${item.line} [${item.kind}] ${item.text}`);
  for (const error of result.errors) console.log(`  ERROR ${error}`);
  if (result.untranslated.length || result.errors.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
