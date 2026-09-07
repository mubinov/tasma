import { QueryClientProvider } from "@tanstack/react-query";
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

// The provider sits inside the boundary: ErrorScreen touches no query client, so
// the panel renders whether or not the provider is still standing. The cache is
// the router's own, so a loader and a screen can never fill different ones.
createRoot(container).render(
  <StrictMode>
    <ThemeSync />
    <ErrorBoundary>
      <QueryClientProvider client={router.options.context.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
