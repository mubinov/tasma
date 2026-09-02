import type { ReactNode } from "react";
import { useTheme } from "../lib/theme";

// Keeps <html> on the resolved theme for as long as the app runs, and renders
// nothing.
export function ThemeSync(): ReactNode {
  useTheme();

  return null;
}
