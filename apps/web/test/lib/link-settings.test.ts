import { describe, expect, it } from "vitest";
import { DEFAULT_LINK_SETTINGS, readLinkSettings } from "../../src/lib/link-settings";

const STORED = {
  browser: "com.example.browser",
  devBrowser: "com.example.dev-browser",
  devDomains: ["example.test", "staging.example.org"],
  fileApp: "com.example.editor",
};

describe("readLinkSettings", () => {
  it("keeps every valid field", () => {
    expect(readLinkSettings(STORED)).toEqual(STORED);
  });

  it("puts each field on its empty value by default", () => {
    expect(DEFAULT_LINK_SETTINGS).toEqual({ browser: "", devBrowser: "", devDomains: [], fileApp: "" });
  });

  it.each(Object.keys(STORED))("gives a missing %s its default and keeps the other fields", (field) => {
    const rest: Record<string, unknown> = { ...STORED };
    Reflect.deleteProperty(rest, field);

    expect(readLinkSettings(rest)).toEqual({ ...STORED, [field]: DEFAULT_LINK_SETTINGS[field as keyof typeof STORED] });
  });

  it.each([
    { field: "browser", value: 42 },
    { field: "devBrowser", value: null },
    { field: "fileApp", value: ["com.example.editor"] },
    { field: "devDomains", value: "example.test" },
    { field: "devDomains", value: ["example.test", 7] },
    { field: "devDomains", value: { 0: "example.test" } },
  ])("gives an invalid $field ($value) its default and keeps the other fields", ({ field, value }) => {
    expect(readLinkSettings({ ...STORED, [field]: value })).toEqual({
      ...STORED,
      [field]: DEFAULT_LINK_SETTINGS[field as keyof typeof STORED],
    });
  });

  it("drops an unknown key", () => {
    expect(readLinkSettings({ ...STORED, theme: "dark" })).toEqual(STORED);
  });

  it.each([null, undefined, "settings", 3, true, []])("gives the defaults for %j, which is not an object", (value) => {
    expect(readLinkSettings(value)).toEqual(DEFAULT_LINK_SETTINGS);
  });
});
