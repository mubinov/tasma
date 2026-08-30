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
 * `line` is decorative by definition and appears in no pair.
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
];

const ROLES = [...SURFACES, ...READABILITY_CONTRACT.map(({ role }) => role), "line"];

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
});

it("declares both palettes", () => {
  expect([...palettes.keys()].sort()).toEqual(["dark", "light"]);
});
