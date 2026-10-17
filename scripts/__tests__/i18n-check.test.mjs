import assert from "node:assert/strict";
import test from "node:test";
import { flattenCatalog, parseCatalogJson, scanTranslationSource, validateCatalogs } from "../i18n-check.mjs";

function catalogs({ en, zhCN }) {
  return {
    en: { settings: flattenCatalog(en), language: flattenCatalog({ current: "Language" }) },
    "zh-CN": { settings: flattenCatalog(zhCN), language: flattenCatalog({ current: "语言" }) },
  };
}

test("accepts static settings calls and matching interpolation", () => {
  const usages = scanTranslationSource('const { t } = useTranslation("settings"); t("appearance.label", { name: user });', "Settings.tsx");
  assert.deepEqual(validateCatalogs({
    catalogs: catalogs({ en: { appearance: { label: "Hello {{name}}" } }, zhCN: { appearance: { label: "你好 {{name}}" } } }),
    usages,
  }), []);
});

test("reports a key missing from the authoritative English catalog", () => {
  const errors = validateCatalogs({
    catalogs: catalogs({ en: {}, zhCN: { missing: "存在" } }),
    usages: [{ file: "Settings.tsx", namespace: "settings", key: "missing" }],
  });
  assert.match(errors.join("\n"), /missing en\/settings key missing/);
});

test("reports target keys that have no English source", () => {
  const errors = validateCatalogs({
    catalogs: catalogs({ en: { known: "Known" }, zhCN: { known: "已知", extra: "多余" } }),
    usages: [],
  });
  assert.match(errors.join("\n"), /orphan target key extra/);
});

test("reports mismatched interpolation parameters", () => {
  const errors = validateCatalogs({
    catalogs: catalogs({ en: { welcome: "Hi {{name}}" }, zhCN: { welcome: "你好 {{user}}" } }),
    usages: [{ file: "Settings.tsx", namespace: "settings", key: "welcome" }],
  });
  assert.match(errors.join("\n"), /interpolation parameters differ/);
});

test("keeps namespaces from useTranslation bindings", () => {
  const usages = scanTranslationSource('import { useTranslation as translate } from "react-i18next"; const { t: language } = translate("language"); language("current");', "Language.tsx");
  assert.deepEqual(usages, [{ file: "Language.tsx", namespace: "language", key: "current" }]);
});

test("rejects dynamic translation keys and namespaces", () => {
  assert.throws(() => scanTranslationSource('const { t } = useTranslation(namespace); t("key");', "Bad.tsx"), /dynamic or empty/);
  assert.throws(() => scanTranslationSource('useTranslation(namespace).t("key");', "Bad.tsx"), /dynamic or empty/);
  assert.throws(() => scanTranslationSource('const { t } = useTranslation("settings"); t(key);', "Bad.tsx"), /dynamic translation key/);
});

test("accepts a static new namespace then requires its English catalog", () => {
  const usages = scanTranslationSource('const { t } = useTranslation("newNamespace"); t("missing");', "New.tsx");
  assert.deepEqual(usages, [{ file: "New.tsx", namespace: "newNamespace", key: "missing" }]);
  const errors = validateCatalogs({
    catalogs: catalogs({ en: {}, zhCN: {} }),
    usages,
  });
  assert.match(errors.join("\n"), /missing authoritative en\/newNamespace\.json/);
});

test("rejects ambiguous t bindings before a key can be attributed to the wrong namespace", () => {
  const source = 'function settings() { const { t } = useTranslation("settings"); t("missing"); } function language() { const { t } = useTranslation("language"); t("current"); }';
  assert.throws(() => scanTranslationSource(source, "Ambiguous.tsx"), /ambiguous translation binding t/);
});

test("rejects direct i18n.t calls", () => {
  assert.throws(() => scanTranslationSource('i18n.t("missing");', "Bypass.tsx"), /direct i18n\.t/);
});

test("rejects duplicate JSON catalog keys before JSON.parse can overwrite one", () => {
  assert.throws(() => parseCatalogJson('{ "title": "First", "title": "Second" }', "en/settings.json"), /duplicate JSON key title/);
});

test("accepts i18next v4 _one and _other plural forms", () => {
  const errors = validateCatalogs({
    catalogs: catalogs({
      en: { item_one: "{{count}} item", item_other: "{{count}} items" },
      zhCN: { item_one: "{{count}} 项", item_other: "{{count}} 项" },
    }),
    usages: [{ file: "Settings.tsx", namespace: "settings", key: "item" }],
  });
  assert.deepEqual(errors, []);
});
