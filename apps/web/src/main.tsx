import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/error-boundary";
import { applyTheme, resolveTheme } from "./lib/theme";
import { router } from "./router";
import { hydrateUiStore } from "./store/ui";
import "./styles/global.css";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("index.html must carry a #root element");
}

// The stored preference is resolved and written before the first render.
// Written from an effect instead, a preference that disagrees with the system
// paints wrong for the whole parse-and-mount window and then flips.
applyTheme(resolveTheme(hydrateUiStore()));

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);
