import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const THEME_CSS = readFileSync(join(import.meta.dirname, "../src/styles/theme.css"), "utf8");

const PALETTE_DECLARATION = /--palette-([a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/g;

/** Every surface a foreground role can be placed on. */
const SURFACES = ["bg", "surface", "surface-2"] as const;

/**
 * The design contract: which role has to stay readable on every surface, and
 * the ratio it has to keep. Text roles meet WCAG 2.2 AA (1.4.3) at 4.5:1;
 * `graphic` carries meaning without being text, so it meets 1.4.11 at 3:1.
 * `line` is decorative and is no surface of this contract; its one text pair
 * is the band of a group of the chat list, below. The `chart-*` fills are
 * decorative too, and tell diagram series apart by hue.
 */
const READABILITY_CONTRACT: readonly { role: string; minimum: number }[] = [
  { role: "text", minimum: 4.5 },
  { role: "muted", minimum: 4.5 },
  { role: "dim", minimum: 4.5 },
  { role: "signal", minimum: 4.5 },
  { role: "running", minimum: 4.5 },
  // Also the mark that tells one control state from another. A selected
  // segment told apart by its surface alone is roughly 1.1:1 against the group
  // it sits in and invisible, so the mark carries the state and holds 3:1 on
  // every surface it can sit on.
  { role: "graphic", minimum: 3 },
  // The focus ring is 2px, and an indicator thinner than 3px is held at 4.5:1
  // rather than the 3:1 that 1.4.11 asks of a thicker one.
  { role: "focus", minimum: 4.5 },
];

const CHART_ROLES = Array.from({ length: 8 }, (_, index) => `chart-${String(index + 1)}`);

/** The fills of the find matches, which hold the page's text and no other foreground. */
const MATCH_ROLES = ["match", "match-current"];

const ROLES = [...SURFACES, ...READABILITY_CONTRACT.map(({ role }) => role), "line", ...CHART_ROLES, ...MATCH_ROLES];

/** Both palettes, read from the light-dark() pair each role declares. */
function readPalettes(css: string): Map<string, Map<string, string>> {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  for (const declaration of css.matchAll(PALETTE_DECLARATION)) {
    light.set(declaration[1]!, declaration[2]!);
    dark.set(declaration[1]!, declaration[3]!);
  }
  return new Map([
    ["light", light],
    ["dark", dark],
  ]);
}

function channel(byte: number): number {
  const srgb = byte / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function byteAt(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

/** Relative luminance of a #rrggbb colour, per WCAG 2.2. */
function luminance(hex: string): number {
  const red = channel(byteAt(hex, 1));
  const green = channel(byteAt(hex, 3));
  const blue = channel(byteAt(hex, 5));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const one = luminance(foreground);
  const other = luminance(background);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

const palettes = readPalettes(THEME_CSS);

describe.each([...palettes])("the %s palette", (_theme, palette) => {
  it("declares every role", () => {
    expect([...palette.keys()].sort()).toEqual([...ROLES].sort());
  });

  it.each(READABILITY_CONTRACT)("keeps $role readable on every surface at $minimum:1", ({ role, minimum }) => {
    for (const surface of SURFACES) {
      expect(contrast(palette.get(role)!, palette.get(surface)!), `${role} on ${surface}`).toBeGreaterThanOrEqual(
        minimum,
      );
    }
  });

  it.each(MATCH_ROLES)("keeps text readable on the %s fill at 4.5:1", (fill) => {
    expect(contrast(palette.get("text")!, palette.get(fill)!)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps muted readable on the line fill of a chat list band at 4.5:1", () => {
    expect(contrast(palette.get("muted")!, palette.get("line")!)).toBeGreaterThanOrEqual(4.5);
  });
});

it("declares both palettes", () => {
  expect([...palettes.keys()].sort()).toEqual(["dark", "light"]);
});

// The scrim is one value for both themes rather than a light-dark() pair, so
// PALETTE_DECLARATION does not match it and readPalettes never sees it.
it("declares the scrim, which is outside both palettes", () => {
  expect(THEME_CSS).toContain("--palette-scrim:");
});
