import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemeSync } from "./components/theme-sync";
import { applyTheme, resolveTheme } from "./lib/theme";
import { router } from "./router";
import { hydrateUiStore } from "./store/ui";
import "./styles/global.css";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("index.html must carry a #root element");
}

// The theme is applied before the first render: written from an effect instead,
// a preference that disagrees with the system paints wrong and then flips.
const { themePreference } = hydrateUiStore();
applyTheme(resolveTheme(themePreference));

createRoot(container).render(
  <StrictMode>
    <ThemeSync />
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);
