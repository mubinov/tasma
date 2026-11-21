import { describe, expect, it } from "vitest";
import type { Browser } from "../../src/api/browsers";
import { menuBrowsers } from "../../src/lib/menu-browsers";

const SAFARI: Browser = { id: "com.apple.Safari", name: "Safari", default: true };
const CHROME: Browser = { id: "com.google.Chrome", name: "Google Chrome", default: false };
const FIREFOX: Browser = { id: "org.mozilla.firefox", name: "Firefox", default: false };
const ORBIT: Browser = { id: "com.example.orbit", name: "Orbit", default: false };

function ids(list: Browser[]): string[] {
  return list.map(({ id }) => id);
}

describe("menuBrowsers", () => {
  it("lists the macOS default, then the development browser, then the other known browsers", () => {
    expect(ids(menuBrowsers([CHROME, FIREFOX, SAFARI], "", CHROME.id))).toEqual([SAFARI.id, CHROME.id, FIREFOX.id]);
  });

  it("puts the saved default first and lists it once", () => {
    expect(ids(menuBrowsers([CHROME, FIREFOX, SAFARI], CHROME.id, ""))).toEqual([CHROME.id, SAFARI.id, FIREFOX.id]);
  });

  it("lists a development browser equal to the default once", () => {
    expect(ids(menuBrowsers([CHROME, SAFARI], CHROME.id, CHROME.id))).toEqual([CHROME.id, SAFARI.id]);
  });

  it("puts a development browser that is not a known browser second", () => {
    expect(ids(menuBrowsers([ORBIT, SAFARI], "", ORBIT.id))).toEqual([SAFARI.id, ORBIT.id]);
  });

  it("takes a saved default that is not in the list as the macOS default", () => {
    expect(ids(menuBrowsers([CHROME, SAFARI], ORBIT.id, ""))).toEqual([SAFARI.id, CHROME.id]);
  });

  it("gives no development browser for one that is not in the list", () => {
    expect(ids(menuBrowsers([ORBIT, SAFARI], "", "com.example.gone"))).toEqual([SAFARI.id]);
  });

  it("gives no default item when no entry is the default and none is saved", () => {
    const list = [{ ...CHROME }, { ...FIREFOX }, { ...SAFARI, default: false }];

    expect(ids(menuBrowsers(list, "", ""))).toEqual([SAFARI.id, CHROME.id, FIREFOX.id]);
  });

  it("leaves out a browser that is not known and not saved", () => {
    expect(ids(menuBrowsers([ORBIT, CHROME, { ...SAFARI, default: false }], "", ""))).toEqual([SAFARI.id, CHROME.id]);
  });

  it("gives the default when it is not a known browser", () => {
    expect(ids(menuBrowsers([{ ...ORBIT, default: true }, FIREFOX], "", ""))).toEqual([ORBIT.id, FIREFOX.id]);
  });

  it("gives nothing for an empty list", () => {
    expect(menuBrowsers([], CHROME.id, FIREFOX.id)).toEqual([]);
  });
});
