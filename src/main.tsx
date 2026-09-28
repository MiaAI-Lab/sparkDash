import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Defined by the inline boot script in index.html; fades the splash away.
declare global {
  interface Window {
    __hideSplash?: () => void;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Reveal the app once it has actually painted: wait two animation frames (a
// committed frame is on-screen) plus a ~450 ms minimum, so the boot splash reads
// as a deliberate transition rather than a strobe.
requestAnimationFrame(() =>
  requestAnimationFrame(() => window.setTimeout(() => window.__hideSplash?.(), 450)),
);

// Register the PWA service worker for offline app shell + installability.
// Production only: dev is served by Vite on :5173 where a caching worker would
// fight HMR. Guard on the API existing — over a plain-http LAN origin
// (e.g. http://dell.lan:5555) browsers hide navigator.serviceWorker entirely,
// and it is only available in secure contexts (https, http://localhost,
// http://127.0.0.1, or an origin whitelisted via the insecure-origin flag).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("[sparkDash] service worker registration failed:", err);
    });
  });
}
