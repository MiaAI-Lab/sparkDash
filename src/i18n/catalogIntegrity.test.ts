import { createInstance } from "i18next";
import ICU from "i18next-icu";
import { expect, it } from "vitest";
import { loadLocaleCatalogs } from "./resources";

const sources = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

function flatten(value: unknown, key: string, result: Record<string, string>) {
  if (typeof value === "string") result[key] = value;
  else if (value && typeof value === "object") {
    for (const [child, text] of Object.entries(value)) flatten(text, `${key}.${child}`, result);
  }
}

it("formats every Chinese message and inline English default with the runtime ICU plugin", async () => {
  const chinese: Record<string, string> = {};
  for (const [ns, catalog] of Object.entries(await loadLocaleCatalogs("zh-Hans"))) flatten(catalog, ns, chinese);
  const english: Record<string, string> = {};
  for (const [file, source] of Object.entries(sources)) {
    if (/\.test\./.test(file) || (file.startsWith("../i18n/") && file !== "../i18n/messages.ts")) continue;
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"/g)) {
      // Decode JS double-quoted literals before ICU sees them. Keep each call
      // site separate even when several sites share a translation key.
      english[`${file}:${match.index}:${match[1]}`] = JSON.parse('"' + match[2] + '"');
    }
  }

  expect(Object.keys(chinese).length).toBeGreaterThan(1300);
  expect(Object.keys(english).length).toBeGreaterThan(1300);
  for (const [language, messages] of Object.entries({ en: english, "zh-Hans": chinese })) {
    const instance = createInstance().use(new ICU({ parseErrorHandler: (error) => { throw error; } }));
    await instance.init({ lng: language, resources: { [language]: { translation: messages } }, nsSeparator: false, keySeparator: false });
    for (const [key, message] of Object.entries(messages)) {
      const variables = Object.fromEntries([...message.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => [m[1], 2]));
      expect(() => instance.t(key, variables), `${language}: ${key}`).not.toThrow();
    }
  }
});
