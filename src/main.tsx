import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrapI18n } from "./i18n";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import "./styles/shell.css";

// Initialise i18n before the first render: English defaults are available
// synchronously, a translated catalog (if the user chose one) is fetched and
// swapped in as soon as it arrives.
bootstrapI18n();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);