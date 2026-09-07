import type { Diagnostic, DiagnosticCode } from "@tasma/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Diagnostics } from "../../src/components/diagnostics";

const FINDINGS: Diagnostic[] = [
  { code: "config-key-unknown", message: "unknown key: colour", path: "/repos/dobby/config.yml", line: 4 },
  { code: "path-missing", message: "the repository is not on disk", path: "/repos/dobby" },
  { code: "next-task-id-rebuilt", message: "the next id was rebuilt from the files on disk" },
];

function rows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Diagnostics" })).getAllByRole("listitem");
}

afterEach(cleanup);

// The element renders wherever a success is read, and most calls report nothing.
it("renders nothing for an empty report", () => {
  const { container } = render(<Diagnostics items={[]} />);

  expect(container.innerHTML).toBe("");
});

it("renders one row per finding, with its code and its message", () => {
  render(<Diagnostics items={FINDINGS} />);

  expect(rows().map((row) => row.textContent)).toEqual([
    "config-key-unknownunknown key: colour/repos/dobby/config.yml:4",
    "path-missingthe repository is not on disk/repos/dobby",
    "next-task-id-rebuiltthe next id was rebuilt from the files on disk",
  ]);
});

// Where a finding names a line, the location is the file and the line together;
// a finding about a whole file names the file, and one about neither names none.
it("appends the line to the path only where the finding names one", () => {
  render(<Diagnostics items={FINDINGS} />);

  expect(within(rows()[0]!).getByText("/repos/dobby/config.yml:4")).toBeTruthy();
  expect(within(rows()[1]!).getByText("/repos/dobby")).toBeTruthy();
  // The location line is the row's own child; the code chip is nested inside it.
  expect(rows()[2]!.querySelector(":scope > span")).toBeNull();
});

/*
 * The element switches on no code, which is what keeps it whole when the daemon
 * adds one: a finding is its code, its message and where it was found, whatever
 * the code says.
 */
it("renders a code it has never seen the same way as every other", () => {
  const unseen = "index-rebuilt-from-scratch" as DiagnosticCode;
  render(<Diagnostics items={[{ code: unseen, message: "the index was rebuilt" }]} />);

  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.textContent).toBe("index-rebuilt-from-scratchthe index was rebuilt");
});
