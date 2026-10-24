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

it("says this project by default", () => {
  render(<LiveNotice />);

  expect(screen.getByRole("note").textContent).toBe(
    "The index is not following the disk"
    + "The daemon could not repair the index of this project on this request. What it reports about this project "
    + "can be older than the files on disk. Reload to try again.",
  );
});

it("names the project in the title and the text", () => {
  render(<LiveNotice project="ALPHA" />);

  expect(screen.getByRole("note").textContent).toBe(
    "The index of ALPHA is not following the disk"
    + "The daemon could not repair the index of ALPHA on this request. What it reports about ALPHA "
    + "can be older than the files on disk. Reload to try again.",
  );
});
