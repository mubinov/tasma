import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LiveNotice } from "../../src/components/live-notice";

afterEach(cleanup);

it("takes the margin the screen gives it", () => {
  render(<LiveNotice className="mt-7" />);

  expect(screen.getByRole("note").classList.contains("mt-7")).toBe(true);
});

it("puts no undefined into its class where the screen gives no class", () => {
  render(<LiveNotice />);

  expect(screen.getByRole("note").className).not.toContain("undefined");
});
