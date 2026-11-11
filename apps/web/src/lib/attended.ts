/** The reader is in the window, so a spoken line reaches them. */
export function attended(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}
