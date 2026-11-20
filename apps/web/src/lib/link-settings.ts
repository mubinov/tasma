// Imports nothing and touches no DOM: the repo tests import it under Node.

export type LinkSettings = {
  /** The bundle id of the default browser. Empty: the macOS default browser. */
  browser: string;
  /** The bundle id of the development browser. Empty: no development rule. */
  devBrowser: string;
  /** Lowercase host names, each with its subdomains. Empty: only localhost and IP addresses. */
  devDomains: string[];
  /** The bundle id of a code editor. Empty: the macOS default app for the file type. */
  fileApp: string;
};

/** Its keys are the field names that the macOS app reads; a repo test holds the two together. */
export const DEFAULT_LINK_SETTINGS: LinkSettings = { browser: "", devBrowser: "", devDomains: [], fileApp: "" };

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

/** Each field is read on its own: an invalid one takes its default, and the others still apply. */
export function readLinkSettings(value: unknown): LinkSettings {
  const fields = typeof value === "object" && value !== null ? (value as Partial<Record<keyof LinkSettings, unknown>>) : {};

  return {
    browser: readString(fields.browser),
    devBrowser: readString(fields.devBrowser),
    devDomains: readStrings(fields.devDomains),
    fileApp: readString(fields.fileApp),
  };
}
