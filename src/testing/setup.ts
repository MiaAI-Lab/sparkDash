import { afterEach } from "vitest";
import { cleanupRenders } from "./render";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanupRenders();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-density");
});
