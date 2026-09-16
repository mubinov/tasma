import type { Diagnostic, DiagnosticCode, ExcludedFile } from "@tasma/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Diagnostics } from "../../src/components/diagnostics";

const WARNINGS: Diagnostic[] = [
  { code: "config-key-unknown", message: "unknown key: colour", path: "/repos/delta/config.yml", line: 4 },
  { code: "path-missing", message: "the repository is not on disk", path: "/repos/delta" },
  { code: "next-task-id-rebuilt", message: "the next id was rebuilt from the files on disk" },
];

const EXCLUDED: ExcludedFile[] = [
  { path: "/repos/delta/tasks/DELTA-7.md", code: "task-file-unreadable", message: "the front matter is not YAML" },
  { path: "/repos/delta/tasks/notes.md", code: "task-file-misnamed", message: "the name holds no task id" },
];

function rows(name: string): HTMLElement[] {
  return within(screen.getByRole("list", { name })).getAllByRole("listitem");
}

function toggle(): HTMLElement {
  return screen.getByRole("button");
}

async function unfold(): Promise<void> {
  await userEvent.setup().click(toggle());
}

afterEach(cleanup);

// The element renders wherever a success is read, and most calls report nothing.
it("renders nothing for an empty report", () => {
  const { container } = render(<Diagnostics items={[]} excluded={[]} subject="this project" />);

  expect(container.innerHTML).toBe("");
});

it("shows the warnings folded under one line", () => {
  render(<Diagnostics items={WARNINGS.slice(0, 2)} subject="this project" />);

  expect(screen.getByRole("heading", { level: 2, name: "2 warnings about this project" }).textContent).toBe(
    "2 warnings about this project",
  );
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
});

it("says warning for one", () => {
  render(<Diagnostics items={WARNINGS.slice(0, 1)} subject="this project" />);

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("1 warning about this project");
});

it("names the projects as the subject on the list of projects", () => {
  render(<Diagnostics items={WARNINGS.slice(0, 1)} subject="the projects" />);

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("1 warning about the projects");
});

it("counts the files that were not read as warnings", () => {
  render(<Diagnostics items={WARNINGS.slice(0, 1)} excluded={EXCLUDED} subject="this project" />);

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("3 warnings about this project");
});

it("shows the line for files that were not read when no item is given", () => {
  render(<Diagnostics items={[]} excluded={EXCLUDED.slice(0, 1)} subject="this project" />);

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("1 warning about this project");
});

it("names the button with what it does and the count", () => {
  render(<Diagnostics items={WARNINGS.slice(0, 2)} subject="this project" />);

  expect(screen.getByRole("button", { name: "Show 2 warnings about this project" })).toBe(toggle());
});

it("unfolds the list with Show and folds it with Hide", async () => {
  const user = userEvent.setup();
  render(<Diagnostics items={WARNINGS.slice(0, 2)} subject="this project" />);

  await user.click(toggle());

  const list = screen.getByRole("list", { name: "2 warnings about this project" });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(toggle().getAttribute("aria-controls")).toBe(list.id);
  expect(screen.getByRole("button", { name: "Hide 2 warnings about this project" })).toBe(toggle());

  await user.click(toggle());

  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
});

it("lists the files that were not read first, each with its path and no line", async () => {
  render(<Diagnostics items={WARNINGS.slice(0, 2)} excluded={EXCLUDED} subject="this project" />);
  await unfold();

  expect(rows("4 warnings about this project").map((row) => row.textContent)).toEqual([
    "task-file-unreadableThe file was not read: the front matter is not YAML/repos/delta/tasks/DELTA-7.md",
    "task-file-misnamedThe file was not read: the name holds no task id/repos/delta/tasks/notes.md",
    "config-key-unknownunknown key: colour/repos/delta/config.yml:4",
    "path-missingthe repository is not on disk/repos/delta",
  ]);
});

it("renders one row per warning, with its code and its message", async () => {
  render(<Diagnostics items={WARNINGS} subject="this project" />);
  await unfold();

  expect(rows("3 warnings about this project").map((row) => row.textContent)).toEqual([
    "config-key-unknownunknown key: colour/repos/delta/config.yml:4",
    "path-missingthe repository is not on disk/repos/delta",
    "next-task-id-rebuiltthe next id was rebuilt from the files on disk",
  ]);
});

// Where a warning names a line, the location is the file and the line together;
// a warning about a whole file names the file, and one about neither names none.
it("appends the line to the path only where the warning names one", async () => {
  render(<Diagnostics items={WARNINGS} subject="this project" />);
  await unfold();

  const listed = rows("3 warnings about this project");
  expect(within(listed[0]!).getByText("/repos/delta/config.yml:4")).toBeTruthy();
  expect(within(listed[1]!).getByText("/repos/delta")).toBeTruthy();
  // The location line is the row's own child; the code chip is nested inside it.
  expect(listed[2]!.querySelector(":scope > span")).toBeNull();
});

/*
 * The element switches on no code, which is what keeps it whole when the daemon
 * adds one: a warning is its code, its message and where it was found, whatever
 * the code says.
 */
it("renders a code it has never seen the same way as every other", async () => {
  const unseen = "index-rebuilt-from-scratch" as DiagnosticCode;
  render(<Diagnostics items={[{ code: unseen, message: "the index was rebuilt" }]} subject="this project" />);
  await unfold();

  const listed = rows("1 warning about this project");
  expect(listed).toHaveLength(1);
  expect(listed[0]!.textContent).toBe("index-rebuilt-from-scratchthe index was rebuilt");
});

it("keeps the list open when a poll renders new warnings", async () => {
  const { rerender } = render(<Diagnostics items={WARNINGS.slice(0, 2)} subject="this project" />);
  await unfold();

  rerender(<Diagnostics items={WARNINGS} subject="this project" />);

  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(rows("3 warnings about this project")).toHaveLength(3);
});

it("shows warnings that come back after none folded", async () => {
  const { container, rerender } = render(<Diagnostics items={WARNINGS} subject="this project" />);
  await unfold();

  rerender(<Diagnostics items={[]} subject="this project" />);
  expect(container.innerHTML).toBe("");

  rerender(<Diagnostics items={WARNINGS} subject="this project" />);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
});

it("moves focus to main when the line goes while Show or Hide holds it", async () => {
  const { rerender } = render(
    <main tabIndex={-1}>
      <Diagnostics items={WARNINGS} subject="this project" />
    </main>,
  );
  await unfold();
  expect(document.activeElement).toBe(toggle());

  rerender(
    <main tabIndex={-1}>
      <Diagnostics items={[]} subject="this project" />
    </main>,
  );

  expect(document.activeElement).toBe(screen.getByRole("main"));
});

it("leaves focus where it is when the line goes without it", () => {
  const { rerender } = render(
    <main tabIndex={-1}>
      <button type="button">Elsewhere</button>
      <Diagnostics items={WARNINGS} subject="this project" />
    </main>,
  );
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();

  rerender(
    <main tabIndex={-1}>
      <button type="button">Elsewhere</button>
      <Diagnostics items={[]} subject="this project" />
    </main>,
  );

  expect(document.activeElement).toBe(elsewhere);
});

it("shows the line folded under a new key", async () => {
  const { rerender } = render(<Diagnostics key="DELTA" items={WARNINGS} subject="this project" />);
  await unfold();

  rerender(<Diagnostics key="ACME" items={WARNINGS} subject="this project" />);

  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
});
