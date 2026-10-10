import { afterEach } from "vitest";
import { cleanupRenders } from "./render";
import { initI18n } from "../i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Pin every test to English so the suite keeps asserting on the in-source
// default strings. Catalogs are not loaded here; tests that exercise another
// language call setLocale() themselves.
initI18n({ lng: "en" });

afterEach(() => {
  cleanupRenders();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-density");
});
