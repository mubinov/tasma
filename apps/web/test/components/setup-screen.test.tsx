import type { SetupStatus, TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { FolderDialogError } from "../../src/api/folder-dialog";
import { TITLE_COVER_ID } from "../../src/lib/use-top-bar-lengths";
import { useNoticeStore } from "../../src/store/notices";
import { browserPreferenceStorage, setPreferenceStorage, useUiStore } from "../../src/store/ui";
import {
  advance,
  countReads,
  heldBack,
  openWithFeed,
  projectEvent,
  refusalReply,
  renderWithRouter,
  setupStatus,
  startOf,
  stubScrollIntoView,
  stubTransport,
  successReply,
} from "../helpers";

/** The macOS folder dialog: the tests choose whether it is there, and what a pick gives. */
const dialog = vi.hoisted(() => ({ available: true, pick: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("../../src/api/folder-dialog"), async (importOriginal) => ({
  ...await importOriginal(),
  folderDialogAvailable: () => dialog.available,
  pickFolder: () => dialog.pick(),
}));

const START = "/setup?mode=start";
const FULL = "/setup?mode=full";
const FULL_SKIPPED = "/setup?mode=full&skipSkill=true";

const CHECK_IN_PROGRESS = "Check in progress";

const READ_FAILED = "Tasma cannot check the steps now. It tries again every 5 seconds.";

const NEW_MACHINE = setupStatus(
  { cli: "fail", project: "fail", workflow: "fail" },
  { installed: "fail", loggedIn: "not-run", skill: "fail" },
);

const REFUSED = refusalReply(500, { kind: "daemon", code: "internal", message: "the check broke" });

let hasFocus: MockInstance<() => boolean>;

/** Every announcement, with the element that had focus when it was made. */
let said: { words: string; focus: Element | null }[] = [];
const originalAnnounce = useNoticeStore.getState().announce;

function words(): string[] {
  return said.map(({ words: spoken }) => spoken);
}

function trigger(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name},`) });
}

function isOpen(name: string): boolean {
  return trigger(name).getAttribute("aria-expanded") === "true";
}

function descriptionOf(element: HTMLElement): string {
  return element.getAttribute("aria-describedby")!.split(" ")
    .map((id) => document.getElementById(id)!.textContent)
    .join(" | ");
}

/** Opens the screen with its full read held back, so a test chooses when the answer comes. */
async function openHeld(status: SetupStatus = NEW_MACHINE) {
  const held = heldBack();
  const stub = stubTransport({ [START]: successReply(startOf(status)), [FULL]: held.reply });
  const router = await renderWithRouter("/", stub.transport);

  return { stub, router, held };
}

/** Opens the screen, and waits for the first full answer. */
async function openAnswered(status: SetupStatus = NEW_MACHINE) {
  const stub = stubTransport({ [START]: successReply(startOf(status)), [FULL]: successReply(status) });
  const router = await renderWithRouter("/", stub.transport);

  await screen.findByText(/of 6 done/);
  await waitFor(() => {
    expect(words().some((spoken) => spoken.startsWith("The check is complete."))).toBe(true);
  });

  return { stub, router };
}

/** Sends the next full read through a window focus event, and waits for it to land. */
async function nextAnswer(stub: ReturnType<typeof stubTransport>, reply: TransportReply, path = FULL): Promise<void> {
  const before = stub.paths.filter((sent) => sent === path).length;

  stub.replies[path] = reply;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => {
      expect(stub.paths.filter((sent) => sent === path).length).toBeGreaterThan(before);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  });
}

beforeEach(() => {
  dialog.available = true;
  dialog.pick.mockReset();
  window.localStorage.clear();
  setPreferenceStorage(browserPreferenceStorage);
  useUiStore.setState({ skillCheckStopped: false, arrivalWords: null, keyPressed: false });
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  said = [];
  useNoticeStore.setState({
    announce: (spoken) => {
      said.push({ words: spoken, focus: document.activeElement });
    },
  });
});

afterEach(() => {
  cleanup();
  useNoticeStore.setState({ announce: originalAnnounce });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the layout", () => {
  it("sets the title, and keeps the title cover", async () => {
    await openHeld();

    expect(document.title).toBe("Set up · Tasma");
    expect(document.getElementById(TITLE_COVER_ID)).not.toBeNull();
  });

  it("holds the one h1 in main, with the name in the band and no banner", async () => {
    await openHeld();

    const main = screen.getByRole("main");
    const headings = screen.getAllByRole("heading");

    expect(headings).toHaveLength(1);
    expect(main.contains(headings[0]!)).toBe(true);
    expect(main.contains(screen.getByText("Tasma"))).toBe(false);
    expect(document.getElementById(TITLE_COVER_ID)!.textContent).toBe("Tasma");
    expect(document.getElementById(TITLE_COVER_ID)!.classList.contains("shadow-[inset_0_-1px_0_var(--color-line)]")).toBe(true);
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByText("Complete these steps to run your first task.")).toBeTruthy();
  });

  it("keeps the content of main below the band", async () => {
    await openHeld();

    expect(screen.getByRole("main").classList.contains("pt-[calc(clamp(1.5rem,11vh,6.5rem)+var(--title-band))]")).toBe(true);
  });

  it("lists the 6 steps in an ordered list that the heading names", async () => {
    await openAnswered();

    const list = screen.getByRole("list", { name: "Set up Tasma" });

    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(list.textContent).toContain("Install the Claude Code CLI");
    expect(list.textContent).toContain("Add a workflow");
    expect(screen.getByText("0 of 6 done")).toBeTruthy();
  });

  it("names a trigger with the step and its label", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    expect(screen.getByRole("button", { name: "Add a project, You do this" })).toBeTruthy();
  });

  it("makes a done step a plain row, outside the Tab order", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    expect(screen.queryByRole("button", { name: /^Install the Claude Code CLI/ })).toBeNull();
    expect(screen.getByText("Install the Claude Code CLI")).toBeTruthy();
    expect(screen.getByText("4 of 6 done")).toBeTruthy();
  });

  it("does not make the name of a step a heading", async () => {
    await openAnswered();

    expect(screen.queryByRole("heading", { name: /Install the Claude Code CLI/ })).toBeNull();
  });
});

describe("before the first full answer", () => {
  it("shows steps 1 to 3 in progress, as plain rows", async () => {
    await openHeld();

    expect(screen.getAllByText(CHECK_IN_PROGRESS)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /^Install the Claude Code CLI/ })).toBeNull();
    expect(trigger("Add a project")).toBeTruthy();
  });

  it("has no current step, and opens no step", async () => {
    await openHeld();

    expect(document.querySelector("[aria-current]")).toBeNull();
    expect(document.querySelector("[aria-expanded=\"true\"]")).toBeNull();
  });

  it("lets the user open steps 4 to 6", async () => {
    await openHeld();

    await userEvent.click(trigger("Add a project"));

    expect(isOpen("Add a project")).toBe(true);
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeTruthy();
  });
});

describe("the first full answer", () => {
  it("opens the current step, marks it and announces the result", async () => {
    const { held } = await openHeld(setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail", skill: "fail" }));

    await act(async () => {
      held.answer(successReply(setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail", skill: "fail" })));
    });

    await waitFor(() => {
      expect(isOpen("Log in to Claude Code")).toBe(true);
    });
    expect(trigger("Log in to Claude Code").getAttribute("aria-current")).toBe("step");
    expect(words()).toEqual(["The check is complete. 2 of 6 steps are done. Next: Log in to Claude Code."]);
    expect(screen.getByText("claude auth login")).toBeTruthy();
  });

  it("does not announce a change to done for a step that was in progress", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    expect(words().filter((spoken) => spoken.endsWith(": done."))).toEqual([]);
  });

  it("leaves out the next step when no step is current", async () => {
    await openAnswered(setupStatus({ project: "not-run", workflow: "fail" }));

    expect(words()).toEqual(["The check is complete. 4 of 6 steps are done."]);
  });

  it("gives each step its content", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail", cli: "fail" }, { installed: "fail", loggedIn: "not-run", skill: "fail" }));

    expect(isOpen("Install the Claude Code CLI")).toBe(true);
    expect(screen.getByText("Tasma runs your workflows with Claude Code.")).toBeTruthy();

    const guide = screen.getByRole("link", { name: "Open the Claude Code CLI install guide (opens in the browser)" });

    expect(guide.getAttribute("href")).toBe("https://code.claude.com/docs/en/setup");
    expect(guide.getAttribute("target")).toBe("_blank");

    await userEvent.click(trigger("Log in to Claude Code"));
    expect(screen.getByText("First, complete step 1: Install the Claude Code CLI.")).toBeTruthy();

    await userEvent.click(trigger("Add the tasma command"));
    expect(screen.getByText(/macOS asks for your password one time/)).toBeTruthy();
    expect(screen.getByText("Tasma > Install Command Line Tool…")).toBeTruthy();

    await userEvent.click(trigger("Install the tasma skill in Claude Code"));
    expect(screen.getByRole("button", { name: "Install in Claude Code" })).toBeTruthy();
    expect(screen.queryByText("npx skills add mubinov/tasma-skill -g")).toBeNull();
    expect(screen.getByRole("link", { name: "Other ways to install the skill (opens in the browser)" }).getAttribute("href"))
      .toBe("https://github.com/mubinov/tasma-skill#install");

    await userEvent.click(trigger("Add a project"));
    expect(screen.getByText("Choose the folder with your code. Claude Code works in this folder.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose folder" }).className).toContain("bg-text");
    expect(screen.queryByText("tasma project create --path .")).toBeNull();

    await userEvent.click(trigger("Add a workflow"));
    expect(screen.getByText("First, complete step 5: Add a project.")).toBeTruthy();
  });

  it("gives step 6 its content when step 5 is done", async () => {
    const stub = stubTransport({
      [START]: successReply(startOf(setupStatus({ workflow: "fail" }))),
      [FULL]: successReply(setupStatus({ workflow: "fail" })),
      "/projects": successReply([{ tag: "ORBI", name: "orbit-notes", path: "/Users/sample/code/orbit-notes" }]),
    });

    await renderWithRouter("/", stub.transport);
    await screen.findByRole("button", { name: "Add workflow" });

    expect(isOpen("Add a workflow")).toBe(true);
    expect(screen.getByText(/^Tasma adds a default development workflow to/).textContent)
      .toBe("Tasma adds a default development workflow to orbit-notes. You can change it later.");
  });
});

describe("the current step", () => {
  it("keeps its mark when it is collapsed", async () => {
    await openAnswered();

    await userEvent.click(trigger("Install the Claude Code CLI"));

    expect(isOpen("Install the Claude Code CLI")).toBe(false);
    expect(trigger("Install the Claude Code CLI").getAttribute("aria-current")).toBe("step");
    expect(trigger("Install the Claude Code CLI").querySelector(".bg-signal")).not.toBeNull();
  });

  it("is the only current step", async () => {
    await openAnswered();

    expect(document.querySelectorAll("[aria-current=\"step\"]")).toHaveLength(1);
  });

  it("colours the label only when the user does the step", async () => {
    await openAnswered(setupStatus({ cli: "fail", project: "fail", workflow: "fail" }));

    expect(within(trigger("Add the tasma command")).getByText("Tasma does this").className).toContain("text-dim");

    await userEvent.click(trigger("Add a project"));

    expect(within(trigger("Add a project")).getByText("You do this").className).toContain("text-dim");
  });

  it("colours the label of the current step that the user does", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    expect(within(trigger("Add a project")).getByText("You do this").className).toContain("text-signal");
  });

  it("does not colour the label of a current step that names its state", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }, { installed: "unknown" }));

    expect(trigger("Install the Claude Code CLI").getAttribute("aria-current")).toBe("step");
    expect(within(trigger("Install the Claude Code CLI")).getByText("Cannot check").className).toContain("text-dim");
  });
});

describe("opening by itself", () => {
  it("opens one step at a time", async () => {
    await openAnswered();

    await userEvent.click(trigger("Add a project"));

    expect(isOpen("Add a project")).toBe(true);
    expect(isOpen("Install the Claude Code CLI")).toBe(false);
  });

  it("opens the next step when the current step changes to done", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    await nextAnswer(stub, successReply(setupStatus({ workflow: "fail" })));

    expect(isOpen("Add a workflow")).toBe(true);
  });

  it("keeps a panel that the user opened by a click when the first full answer makes another step current", async () => {
    const { held } = await openHeld();

    await userEvent.click(trigger("Add a project"));
    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      held.answer(successReply(NEW_MACHINE));
    });
    await waitFor(() => {
      expect(trigger("Install the Claude Code CLI").getAttribute("aria-current")).toBe("step");
    });

    expect(isOpen("Add a project")).toBe(true);
    expect(isOpen("Install the Claude Code CLI")).toBe(false);
  });

  it("keeps a panel that the user opened with Enter while focus stays on its trigger", async () => {
    const { held } = await openHeld();

    trigger("Add a project").focus();
    await userEvent.keyboard("{Enter}");
    await act(async () => {
      held.answer(successReply(NEW_MACHINE));
    });
    await waitFor(() => {
      expect(trigger("Install the Claude Code CLI").getAttribute("aria-current")).toBe("step");
    });

    expect(isOpen("Add a project")).toBe(true);
    expect(document.activeElement).toBe(trigger("Add a project"));
  });

  it("keeps a step that opened by itself while focus is in it", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    trigger("Add a project").focus();
    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail" })));

    expect(trigger("Log in to Claude Code").getAttribute("aria-current")).toBe("step");
    expect(isOpen("Add a project")).toBe(true);
    expect(isOpen("Log in to Claude Code")).toBe(false);
  });

  it("opens the new current step when focus is on the trigger of a closed step", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    trigger("Add a workflow").focus();
    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail" })));

    expect(isOpen("Log in to Claude Code")).toBe(true);
    expect(document.activeElement).toBe(trigger("Add a workflow"));
  });

  it("counts a press inside a panel as opened by hand", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));
    dialog.pick.mockResolvedValue(null);

    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    (document.activeElement as HTMLElement).blur();
    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail" })));

    expect(isOpen("Add a project")).toBe(true);
    expect(isOpen("Log in to Claude Code")).toBe(false);
  });

  it("does not count a press on the text of a panel as opened by hand", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    await userEvent.click(screen.getByText(/Choose the folder with your code/));
    (document.activeElement as HTMLElement).blur();
    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail" })));

    expect(isOpen("Log in to Claude Code")).toBe(true);
  });

  it("opens the current step when the user closes the panel opened by hand", async () => {
    await openAnswered();

    await userEvent.click(trigger("Add a project"));
    await userEvent.click(trigger("Add a project"));

    expect(isOpen("Install the Claude Code CLI")).toBe(true);
  });

  it("leaves the current step closed when the user closes it", async () => {
    await openAnswered();

    await userEvent.click(trigger("Install the Claude Code CLI"));
    expect(isOpen("Install the Claude Code CLI")).toBe(false);

    await userEvent.click(trigger("Install the Claude Code CLI"));
    expect(isOpen("Install the Claude Code CLI")).toBe(true);

    await userEvent.click(trigger("Install the Claude Code CLI"));
    expect(isOpen("Install the Claude Code CLI")).toBe(false);
  });

  it("opens no step when the user closes a panel before the first full answer", async () => {
    await openHeld();

    await userEvent.click(trigger("Add a project"));
    await userEvent.click(trigger("Add a project"));

    expect(document.querySelector("[aria-expanded=\"true\"]")).toBeNull();
  });

  it("opens the current step when the step of the panel opened by hand changes to done", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" }));

    await userEvent.click(trigger("Add a project"));
    await nextAnswer(stub, successReply(setupStatus({ workflow: "fail" }, { skill: "fail" })));

    expect(isOpen("Install the tasma skill in Claude Code")).toBe(true);
  });

  it("closes the panel of a step that changes to done when no step is current", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "not-run", workflow: "fail" }, { skill: "fail" }));

    await nextAnswer(stub, successReply(setupStatus({ project: "not-run", workflow: "fail" })));

    expect(screen.getByText("Install the tasma skill in Claude Code").closest("button")).toBeNull();
    expect(document.querySelector("[aria-expanded=\"true\"]")).toBeNull();
  });
});

describe("the reads", () => {
  it("reads the full status at open, every 5 seconds and on a window focus event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = stubTransport({ [START]: successReply(startOf(NEW_MACHINE)), [FULL]: successReply(NEW_MACHINE) });
    await renderWithRouter("/", stub.transport);
    const reads = countReads(stub, FULL);

    expect(stub.paths.filter((path) => path === FULL)).toHaveLength(1);

    await advance(5000);
    expect(reads()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    await advance(10);
    expect(reads()).toBe(1);
  });

  it("starts no second read while one runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { stub } = await openHeld();
    const reads = countReads(stub, FULL);

    window.dispatchEvent(new Event("focus"));
    await advance(5000);

    expect(reads()).toBe(0);
  });

  it("keeps the last answer while a read runs", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));
    const { reply } = heldBack();

    stub.replies[FULL] = reply;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(screen.queryByText(CHECK_IN_PROGRESS)).toBeNull();
    expect(screen.getByText("4 of 6 done")).toBeTruthy();
  });

  it("reads again on a project event", async () => {
    const stub = stubTransport({ [START]: successReply(startOf(NEW_MACHINE)), [FULL]: successReply(NEW_MACHINE) });
    const { feed } = await openWithFeed("/", stub);
    const reads = countReads(stub, FULL);

    await feed.send([projectEvent("SAGA", "created")]);

    await waitFor(() => {
      expect(reads()).toBe(1);
    });
  });
});

describe("a change to done", () => {
  it("announces the step, and plays the effect on its mark", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    await nextAnswer(stub, successReply(setupStatus({ workflow: "fail" })));

    expect(words()).toContain("Add a project: done.");

    const row = screen.getByText("Add a project").closest("li")!;

    expect(row.querySelector(".animate-step-done")).not.toBeNull();
    expect(row.querySelector(".motion-reduce\\:animate-none")).not.toBeNull();
  });

  it("plays no effect on a step that was in progress", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    expect(screen.getByText("Install the Claude Code CLI").closest("li")!.querySelector(".animate-step-done")).toBeNull();
  });

  it("announces nothing for a read that changes no step", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));
    said = [];

    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" })));

    expect(words()).toEqual([]);
  });
});

describe("a failed read", () => {
  it("shows steps 1 to 3 as cannot check after a failed first read, and step 1 as current", async () => {
    const stub = stubTransport({ [START]: successReply(startOf(NEW_MACHINE)), [FULL]: REFUSED });
    await renderWithRouter("/", stub.transport);

    await screen.findByText(READ_FAILED);

    expect(screen.queryByText(CHECK_IN_PROGRESS)).toBeNull();
    expect(screen.getAllByText("Cannot check")).toHaveLength(3);
    expect(trigger("Install the Claude Code CLI").getAttribute("aria-current")).toBe("step");
    expect(document.querySelector("[aria-expanded=\"true\"]")).toBeNull();
    expect(words()).toEqual([READ_FAILED]);
  });

  it("keeps the last answer, and removes the line after a read that succeeds", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    await nextAnswer(stub, REFUSED);

    expect(screen.getByText(READ_FAILED)).toBeTruthy();
    expect(screen.getByText("4 of 6 done")).toBeTruthy();
    expect(words().filter((spoken) => spoken === READ_FAILED)).toHaveLength(1);

    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" })));

    expect(screen.queryByText(READ_FAILED)).toBeNull();
  });
});

describe("Check again", () => {
  const UNKNOWN = setupStatus({ project: "unknown", workflow: "unknown" }, { skill: "fail" });

  it("shows the words and the action in a step that cannot be checked", async () => {
    await openAnswered(setupStatus({ cli: "unknown", project: "fail", workflow: "fail" }));

    expect(isOpen("Add the tasma command")).toBe(true);
    expect(screen.getByText("Tasma cannot check this now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("shows cannot check for a step that the answer did not run", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }, { skill: "not-run" }));

    await userEvent.click(trigger("Install the tasma skill in Claude Code"));

    expect(screen.getByText("Tasma cannot check this now.")).toBeTruthy();
  });

  it("is busy while its read runs, and keeps focus", async () => {
    const { stub } = await openAnswered(UNKNOWN);
    const held = heldBack();

    await userEvent.click(trigger("Add a project"));
    stub.replies[FULL] = held.reply;
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    const busy = screen.getByRole("button", { name: CHECK_IN_PROGRESS });

    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(busy);

    const reads = countReads(stub, FULL);

    await userEvent.click(busy);
    expect(reads()).toBe(0);

    await act(async () => {
      held.answer(successReply(UNKNOWN));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    });
    expect(words().filter((spoken) => spoken === "Tasma still cannot check this.")).toHaveLength(1);
  });

  it("announces when the step still cannot be checked", async () => {
    const { stub } = await openAnswered(UNKNOWN);

    await userEvent.click(trigger("Add a project"));
    stub.replies[FULL] = successReply(UNKNOWN);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(words()).toContain("Tasma still cannot check this.");
    });
  });

  it("announces when its read fails", async () => {
    const { stub } = await openAnswered(setupStatus({ cli: "unknown", project: "fail", workflow: "fail" }));

    stub.replies[FULL] = REFUSED;
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(words()).toContain("Tasma still cannot check this.");
    });
  });

  it("announces only the change when the step can be checked again", async () => {
    const { stub } = await openAnswered(setupStatus({ cli: "unknown", project: "fail", workflow: "fail" }));

    stub.replies[FULL] = successReply(setupStatus({ project: "fail", workflow: "fail" }));
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(words()).toContain("Add the tasma command: done.");
    });
    expect(words()).not.toContain("Tasma still cannot check this.");
  });
});

describe("Stop checking for the skill", () => {
  const SKILL_AND_PROJECT = setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" });
  const SKILL_ONLY = setupStatus({}, { skill: "fail" });
  const STOP = "Stop checking for the skill";

  it("ties the reason and the result to the button", async () => {
    await openAnswered(SKILL_ONLY);

    const button = screen.getByRole("button", { name: STOP });
    const description = document.getElementById(button.getAttribute("aria-describedby")!);

    expect(description?.textContent).toContain("Tasma cannot find it");
    expect(description?.textContent).toContain("also after a restart");
  });

  it("stores the choice, keeps the step open, marks the next step and reads with the skip flag", async () => {
    const stub = stubTransport({
      [START]: successReply(startOf(SKILL_AND_PROJECT)),
      [FULL]: successReply(SKILL_AND_PROJECT),
      [FULL_SKIPPED]: successReply(setupStatus({ project: "fail", workflow: "fail" }, { skill: "not-run" })),
    });
    await renderWithRouter("/", stub.transport);
    await waitFor(() => {
      expect(isOpen("Install the tasma skill in Claude Code")).toBe(true);
    });

    await userEvent.click(screen.getByRole("button", { name: STOP }));

    expect(window.localStorage.getItem("tasma.setup.skillCheck")).toBe("stopped");
    expect(words()).toContain("Tasma does not check for the skill now.");
    expect(screen.getByRole("button", { name: /^Install the tasma skill in Claude Code, Not checked/ })).toBeTruthy();
    expect(screen.getByText(/Claude Code needs the skill to run workflow steps/)).toBeTruthy();
    expect(isOpen("Install the tasma skill in Claude Code")).toBe(true);
    expect(trigger("Add a project").getAttribute("aria-current")).toBe("step");
    expect(isOpen("Add a project")).toBe(false);
    expect(trigger("Install the tasma skill in Claude Code").querySelector(".border-dashed")).not.toBeNull();

    await waitFor(() => {
      expect(stub.paths).toContain(FULL_SKIPPED);
    });
  });

  it("closes the screen when nothing else fails, and says both sentences after the move", async () => {
    const stub = stubTransport({
      [START]: successReply(startOf(SKILL_ONLY)),
      [FULL]: successReply(SKILL_ONLY),
      [FULL_SKIPPED]: successReply(setupStatus({}, { skill: "not-run" })),
    });
    const router = await renderWithRouter("/", stub.transport);

    await waitFor(() => {
      expect(isOpen("Install the tasma skill in Claude Code")).toBe(true);
    });
    said = [];
    await userEvent.click(screen.getByRole("button", { name: STOP }));

    expect(words()).toEqual([]);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(words()).toEqual(["Tasma does not check for the skill now. Setup is complete."]);
    });
    expect(said[0]!.focus).toBe(screen.getByRole("main"));
  });

  it("keeps the screen open on step 2 after the first full answer, while step 2 fails", async () => {
    const LOGIN_AND_SKILL = setupStatus({}, { loggedIn: "fail", skill: "fail" });
    const stub = stubTransport({
      [START]: successReply(startOf(LOGIN_AND_SKILL)),
      [FULL]: successReply(LOGIN_AND_SKILL),
      [FULL_SKIPPED]: successReply(setupStatus({}, { loggedIn: "fail", skill: "not-run" })),
    });
    const router = await renderWithRouter("/", stub.transport);

    await waitFor(() => {
      expect(isOpen("Log in to Claude Code")).toBe(true);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

    await user.click(trigger("Install the tasma skill in Claude Code"));
    await user.click(screen.getByRole("button", { name: STOP }));
    await advance(2000);

    expect(stub.paths).toContain(FULL_SKIPPED);
    expect(router.state.location.pathname).toBe("/setup");
    expect(words()).toContain("Tasma does not check for the skill now.");
    expect(trigger("Log in to Claude Code").getAttribute("aria-current")).toBe("step");
  });

  describe("before the first full answer", () => {
    /** Stops the check while the first full read runs, and holds back the read with the skip flag. */
    async function stopEarly() {
      const skipped = heldBack();
      const { stub, router } = await openHeld(SKILL_ONLY);

      stub.replies[FULL_SKIPPED] = skipped.reply;
      await userEvent.click(trigger("Install the tasma skill in Claude Code"));
      await userEvent.click(screen.getByRole("button", { name: STOP }));
      await waitFor(() => {
        expect(stub.paths).toContain(FULL_SKIPPED);
      });

      expect(screen.getByRole("button", { name: /^Install the tasma skill in Claude Code, Not checked/ })).toBeTruthy();
      expect(words()).toEqual(["Tasma does not check for the skill now."]);
      expect(router.state.location.pathname).toBe("/setup");
      said = [];

      return { router, answer: skipped.answer };
    }

    it("closes after a full answer with no failed step, and says only that setup is complete after the move", async () => {
      const { router, answer } = await stopEarly();

      await act(async () => {
        answer(successReply(setupStatus({}, { skill: "not-run" })));
      });

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/tasks");
      }, { timeout: 3000 });
      await waitFor(() => {
        expect(words()).toEqual(["Setup is complete."]);
      });
    });

    it("stays open on step 2 after a full answer in which step 2 fails", async () => {
      const { router, answer } = await stopEarly();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      await act(async () => {
        answer(successReply(setupStatus({}, { loggedIn: "fail", skill: "not-run" })));
      });
      await advance(2000);

      expect(router.state.location.pathname).toBe("/setup");
      expect(trigger("Log in to Claude Code").getAttribute("aria-current")).toBe("step");
      expect(isOpen("Install the tasma skill in Claude Code")).toBe(true);
      expect(words()).toEqual(["The check is complete. 4 of 6 steps are done. Next: Log in to Claude Code."]);
    });

    it("closes after a failed full read, with no failed-read line, and says only that setup is complete after the move", async () => {
      const { router, answer } = await stopEarly();

      await act(async () => {
        answer(REFUSED);
      });

      expect(await screen.findAllByText("Cannot check")).toHaveLength(3);
      expect(screen.queryByText(READ_FAILED)).toBeNull();

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/tasks");
      }, { timeout: 3000 });
      await waitFor(() => {
        expect(words()).toEqual(["Setup is complete."]);
      });
    });
  });

  describe("with a failed read", () => {
    const SKIPPED_MACHINE = setupStatus(
      { cli: "fail", project: "fail", workflow: "fail" },
      { installed: "fail", loggedIn: "not-run", skill: "not-run" },
    );

    async function stop(): Promise<void> {
      await userEvent.click(trigger("Install the tasma skill in Claude Code"));
      await userEvent.click(screen.getByRole("button", { name: STOP }));
    }

    it("keeps the full answer when the first read with the skip flag fails, and says the result one time", async () => {
      const { stub } = await openAnswered();

      stub.replies[FULL_SKIPPED] = REFUSED;
      await stop();
      await screen.findByText(READ_FAILED);

      expect(screen.queryByText("Cannot check")).toBeNull();
      expect(trigger("Install the Claude Code CLI").textContent).toContain("You do this");

      await nextAnswer(stub, successReply(SKIPPED_MACHINE), FULL_SKIPPED);

      expect(screen.queryByText(READ_FAILED)).toBeNull();
      expect(words().filter((spoken) => spoken.startsWith("The check is complete."))).toHaveLength(1);
    });

    it("keeps steps 1 to 3 as cannot check, and the failed-read line, until a read with the skip flag succeeds", async () => {
      const held = heldBack();
      const stub = stubTransport({
        [START]: successReply(startOf(NEW_MACHINE)),
        [FULL]: REFUSED,
        [FULL_SKIPPED]: held.reply,
      });

      await renderWithRouter("/", stub.transport);
      await screen.findByText(READ_FAILED);
      await stop();
      await waitFor(() => {
        expect(stub.paths).toContain(FULL_SKIPPED);
      });

      expect(screen.getAllByText("Cannot check")).toHaveLength(3);
      expect(screen.queryByText(CHECK_IN_PROGRESS)).toBeNull();
      expect(screen.getByText(READ_FAILED)).toBeTruthy();

      await act(async () => {
        held.answer(successReply(SKIPPED_MACHINE));
      });

      await waitFor(() => {
        expect(screen.queryByText(READ_FAILED)).toBeNull();
      });
      expect(screen.queryByText("Cannot check")).toBeNull();
      expect(words().filter((spoken) => spoken === READ_FAILED)).toHaveLength(1);
    });
  });
});

describe("a failed step of Claude Code or of the tasma command", () => {
  const START_REPLY = successReply(startOf(setupStatus({ workflow: "fail" })));

  it.each([
    ["Install the Claude Code CLI", setupStatus({}, { installed: "fail", loggedIn: "not-run" })],
    ["Log in to Claude Code", setupStatus({}, { loggedIn: "fail" })],
    ["Add the tasma command", setupStatus({ cli: "fail" })],
  ])("keeps the screen open while %s fails, and closes it 1 second after the step passes", async (name, status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = stubTransport({ [START]: START_REPLY, [FULL]: successReply(status) });
    const router = await renderWithRouter("/", stub.transport);

    await advance(2000);

    expect(words().some((spoken) => spoken.startsWith("The check is complete."))).toBe(true);
    expect(router.state.location.pathname).toBe("/setup");
    expect(trigger(name).getAttribute("aria-current")).toBe("step");
    expect(isOpen(name)).toBe(true);

    stub.replies[FULL] = successReply(setupStatus());
    said = [];
    window.dispatchEvent(new Event("focus"));
    await advance(20);

    expect(screen.getByText("6 of 6 done")).toBeTruthy();

    await advance(900);
    expect(router.state.location.pathname).toBe("/setup");

    await advance(200);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    expect(router.history.length).toBe(1);
    await waitFor(() => {
      expect(words()).toEqual(["Setup is complete."]);
    });
  });

  it("closes the screen when the login cannot be checked", async () => {
    const stub = stubTransport({ [START]: START_REPLY, [FULL]: successReply(setupStatus({}, { loggedIn: "unknown" })) });
    const router = await renderWithRouter("/", stub.transport);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    }, { timeout: 3000 });
  });
});

describe("closing", () => {
  const PROJECT_ONLY = setupStatus({ workflow: "fail" });

  describe("the reader in the window", () => {
    /** Opens the screen with step 6 to do, and waits for its first full answer. */
    async function openOnWorkflow() {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const stub = stubTransport({ [START]: successReply(startOf(PROJECT_ONLY)), [FULL]: successReply(PROJECT_ONLY) });
      const router = await renderWithRouter("/", stub.transport);

      await advance(20);
      stub.replies[FULL] = successReply(setupStatus());

      return { stub, router };
    }

    it("starts the close at a focus event of the window, and does not stop it when the reader leaves", async () => {
      const { router } = await openOnWorkflow();

      hasFocus.mockReturnValue(false);
      await advance(5000);

      expect(screen.getByText("6 of 6 done")).toBeTruthy();

      await advance(2000);
      expect(router.state.location.pathname).toBe("/setup");

      said = [];
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      await advance(500);
      hasFocus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      await advance(400);
      expect(router.state.location.pathname).toBe("/setup");

      await advance(200);
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/tasks");
      });
      await waitFor(() => {
        expect(words()).toEqual(["Setup is complete."]);
      });
    });

    it("waits while the page is hidden, also at a focus event, and starts the close when the page shows", async () => {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const { router } = await openOnWorkflow();

      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      // The focus event reads again, and the answer changes the last step to Done.
      window.dispatchEvent(new Event("focus"));
      await advance(20);

      expect(screen.getByText("6 of 6 done")).toBeTruthy();

      window.dispatchEvent(new Event("focus"));
      await advance(2000);
      expect(router.state.location.pathname).toBe("/setup");

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await advance(900);
      expect(router.state.location.pathname).toBe("/setup");

      await advance(200);
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/tasks");
      });
    });

    it("moves one time, 1 second after the first of a focus event and a visibilitychange event", async () => {
      const { router } = await openOnWorkflow();

      hasFocus.mockReturnValue(false);
      await advance(5000);

      expect(screen.getByText("6 of 6 done")).toBeTruthy();

      said = [];
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      await advance(500);
      document.dispatchEvent(new Event("visibilitychange"));
      await advance(400);
      expect(router.state.location.pathname).toBe("/setup");

      await advance(200);
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/tasks");
      });
      expect(router.history.length).toBe(1);
      await waitFor(() => {
        expect(words()).toEqual(["Setup is complete."]);
      });
    });

    it("stops the wait when a later answer needs the setup again, and does not close when the reader comes back", async () => {
      const { stub, router } = await openOnWorkflow();

      hasFocus.mockReturnValue(false);
      await advance(5000);

      expect(screen.getByText("6 of 6 done")).toBeTruthy();

      stub.replies[FULL] = successReply(PROJECT_ONLY);
      await advance(5000);

      expect(screen.getByText("5 of 6 done")).toBeTruthy();

      said = [];
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await advance(2000);

      expect(router.state.location.pathname).toBe("/setup");
      expect(useUiStore.getState().arrivalWords).toBeNull();
      expect(words()).not.toContain("Setup is complete.");
    });
  });

  it("goes to the Tasks page 1 second after every step passes, with replace", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = stubTransport({ [START]: successReply(startOf(PROJECT_ONLY)), [FULL]: successReply(PROJECT_ONLY) });
    const router = await renderWithRouter("/", stub.transport);

    await advance(20);
    stub.replies[FULL] = successReply(setupStatus());
    said = [];
    window.dispatchEvent(new Event("focus"));
    await advance(20);

    expect(screen.getByText("6 of 6 done")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/setup");
    expect(words()).toEqual([]);

    await advance(900);
    expect(router.state.location.pathname).toBe("/setup");

    await advance(200);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    expect(router.history.length).toBe(1);
  });

  it("moves focus to the Tasks page before it says that setup is complete", async () => {
    const { stub, router } = await openAnswered(PROJECT_ONLY);

    said = [];
    await nextAnswer(stub, successReply(setupStatus()));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(words()).toEqual(["Setup is complete."]);
    });
    expect(said[0]!.focus).toBe(screen.getByRole("main"));
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(useUiStore.getState().arrivalWords).toBeNull();
  });

  it("opens no step and says nothing when the first full answer closes the screen", async () => {
    const held = heldBack();
    const stub = stubTransport({ [START]: successReply(startOf(PROJECT_ONLY)), [FULL]: held.reply });
    const router = await renderWithRouter("/", stub.transport);

    await act(async () => {
      held.answer(successReply(setupStatus()));
    });
    await screen.findByText("6 of 6 done");

    expect(router.state.location.pathname).toBe("/setup");
    expect(document.querySelector("[aria-expanded=\"true\"]")).toBeNull();
    expect(words()).toEqual([]);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(words()).toEqual(["Setup is complete."]);
    });
  });

  it("runs no focus fallback for the answer that closes the screen", async () => {
    const { stub } = await openAnswered(PROJECT_ONLY);

    screen.getByRole("button", { name: /^Add a workflow/ }).focus();
    await nextAnswer(stub, successReply(setupStatus()));

    expect(screen.getByText("6 of 6 done")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("stays open when a later answer needs the setup again before it closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = stubTransport({ [START]: successReply(startOf(PROJECT_ONLY)), [FULL]: successReply(PROJECT_ONLY) });
    const router = await renderWithRouter("/", stub.transport);

    await advance(20);
    stub.replies[FULL] = successReply(setupStatus());
    window.dispatchEvent(new Event("focus"));
    await advance(20);
    stub.replies[FULL] = successReply(PROJECT_ONLY);
    window.dispatchEvent(new Event("focus"));
    await advance(2000);

    expect(router.state.location.pathname).toBe("/setup");
    expect(useUiStore.getState().arrivalWords).toBeNull();
  });

  it("goes to the Tasks page at once when it opens with no need, with no full read and no words", async () => {
    const stub = stubTransport();
    const router = await renderWithRouter("/setup", stub.transport);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    expect(stub.paths).not.toContain(FULL);
    expect(words()).toEqual([]);
  });

  it("keeps the spoken region mounted through the move", async () => {
    const { stub, router } = await openAnswered(PROJECT_ONLY);
    const region = document.querySelector("[aria-live=\"polite\"]");

    await nextAnswer(stub, successReply(setupStatus()));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByRole("navigation")).toBeTruthy();
    });

    expect(document.querySelector("[aria-live=\"polite\"]")).toBe(region);
  });
});

describe("Copy", () => {
  const LOGIN = setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail" });

  function stubClipboard(writeText: (text: string) => Promise<void>): void {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  }

  it("copies the command, and reads Copied for 1.5 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const writeText = vi.fn(() => Promise.resolve());

    stubClipboard(writeText);
    await openAnswered(LOGIN);
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("claude auth login");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(words()).toContain("Copied");

    await advance(1600);

    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("selects the command when the copy fails, and says how to copy it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

    stubClipboard(() => Promise.reject(new Error("not allowed")));
    await openAnswered(LOGIN);
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(screen.getByRole("button", { name: "Cannot copy" })).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe("claude auth login");
    expect(words()).toContain("Cannot copy. The command is selected. Press Command-C to copy it.");

    await advance(1600);

    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});

describe("installing the skill", () => {
  const INSTALL = "POST /setup/skill-install";
  const INSTALL_PATH = "/setup/skill-install";
  const SKILL = "Install the tasma skill in Claude Code";
  const SKILL_AND_PROJECT = setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" });
  const ONLY_PROJECT = setupStatus({ project: "fail", workflow: "fail" });
  const ONLY_SKILL = setupStatus({}, { skill: "fail" });
  const INSTALL_WORDS = "Install in Claude Code";
  const BUSY_WORDS = "Install in progress";
  const AGAIN_WORDS = "Try again";
  const STARTED = "Install in progress. This can take up to 2 minutes.";
  const FAILED = "Tasma cannot install the skill. The output is in step 4, above the Try again button.";
  const NO_NPX = "Tasma cannot find npx. The plugin commands are in step 4, above the Try again button.";
  const OUTPUT = "npm error network request failed\nnpm error code ENOTFOUND";
  const OUTPUT_LINE = "Tasma cannot install the skill. The command gave this output:";
  const FIRST_COMMAND = "/plugin marketplace add mubinov/tasma-skill";
  const SECOND_COMMAND = "/plugin install tasma@tasma";

  function installBodies(stub: ReturnType<typeof stubTransport>): unknown[] {
    return stub.requests.filter(({ path }) => path === INSTALL_PATH).map(({ body }) => body);
  }

  function installButton(name = INSTALL_WORDS): HTMLElement {
    return screen.getByRole("button", { name });
  }

  async function press(
    stub: ReturnType<typeof stubTransport>,
    reply: TransportReply | Promise<TransportReply>,
  ): Promise<void> {
    stub.replies[INSTALL] = reply;
    await userEvent.click(installButton());
  }

  async function openFailed(): Promise<ReturnType<typeof stubTransport>> {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);

    await press(stub, successReply({ result: "failed", output: OUTPUT }));
    await screen.findByRole("button", { name: AGAIN_WORDS });

    return stub;
  }

  async function openNoNpx(): Promise<ReturnType<typeof stubTransport>> {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);

    await press(stub, successReply({ result: "npx-missing" }));
    await screen.findByRole("button", { name: AGAIN_WORDS });

    return stub;
  }

  it("shows the install content while the step is to-do, with the owner label and the owner colour of Tasma", async () => {
    await openAnswered(SKILL_AND_PROJECT);

    expect(isOpen(SKILL)).toBe(true);
    expect(screen.getByRole("button", { name: `${SKILL}, Tasma does this` })).toBeTruthy();
    expect(within(trigger(SKILL)).getByText("Tasma does this").className).toContain("text-dim");
    expect(installButton().className).toContain("bg-text");
    expect(screen.queryByText(/Tasma downloads the skill/)).toBeNull();
    expect(screen.queryByText("npx skills add mubinov/tasma-skill -g")).toBeNull();
    expect(screen.getByRole("link", { name: /^Other ways to install the skill/ })).toBeTruthy();
  });

  it("describes the install button by the first sentence, and the stop button by the whole text", async () => {
    await openAnswered(SKILL_AND_PROJECT);

    const first = "If the skill is already in a different folder, Tasma cannot find it, and a second install makes Claude Code load two copies.";

    expect(descriptionOf(installButton())).toBe(first);
    expect(descriptionOf(screen.getByRole("button", { name: "Stop checking for the skill" })))
      .toBe(`${first} In that case, stop the check. Tasma then does not check for the skill again, also after a restart.`);
  });

  it("repeats the POST while the answer is running, is busy, and keeps focus and the element", async () => {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);
    const first = heldBack();
    const second = heldBack();
    const button = installButton();

    said = [];
    await press(stub, first.reply);

    expect(installBodies(stub)).toEqual([{}]);
    expect(installButton(BUSY_WORDS)).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector("svg.animate-spin.motion-reduce\\:animate-none[aria-hidden=\"true\"]")).not.toBeNull();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("button", { name: `${SKILL}, ${BUSY_WORDS}` })).toBeTruthy();
    expect(screen.getByText("Tasma downloads the skill from GitHub. This can take up to 2 minutes.")).toBeTruthy();
    expect(words()).toEqual([STARTED]);

    stub.replies[INSTALL] = second.reply;
    await act(async () => {
      first.answer(successReply({ result: "running", run: "run-1" }));
    });
    await waitFor(() => {
      expect(installBodies(stub)).toEqual([{}, { run: "run-1" }]);
    });

    expect(words()).toEqual([STARTED]);
    expect(document.activeElement).toBe(button);

    await act(async () => {
      second.answer(successReply({ result: "installed" }));
    });
  });

  it("does nothing on a press during the run", async () => {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);
    const held = heldBack();

    await press(stub, held.reply);
    said = [];
    await userEvent.click(installButton(BUSY_WORDS));

    expect(installBodies(stub)).toEqual([{}]);
    expect(words()).toEqual([]);

    await act(async () => {
      held.answer(successReply({ result: "installed" }));
    });
  });

  it("reads the full status after installed, then shows Done and moves focus to the trigger of step 5", async () => {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);
    const read = heldBack();
    const reads = countReads(stub, FULL);

    stub.replies[FULL] = read.reply;
    said = [];
    await press(stub, successReply({ result: "installed" }));
    await waitFor(() => {
      expect(reads()).toBeGreaterThan(0);
    });

    expect(installButton(BUSY_WORDS).getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      read.answer(successReply(ONLY_PROJECT));
    });
    await waitFor(() => {
      expect(screen.getByText(SKILL).closest("button")).toBeNull();
    });

    expect(words()).toEqual([STARTED, `${SKILL}: done.`]);
    await waitFor(() => {
      expect(isOpen("Add a project")).toBe(true);
    });
    expect(document.activeElement).toBe(trigger("Add a project"));
  });

  it("shows the output after failed, with Try again filled and with focus", async () => {
    const stub = await openFailed();
    const again = installButton(AGAIN_WORDS);

    expect(document.activeElement).toBe(again);
    expect(again.className).toContain("bg-text");
    expect(again.getAttribute("aria-disabled")).toBe("false");
    expect(screen.getByRole("button", { name: `${SKILL}, Cannot install` })).toBeTruthy();

    const box = screen.getByRole("group", { name: OUTPUT_LINE });

    expect(box.textContent).toBe(OUTPUT);
    expect(box.tagName).toBe("PRE");
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.className).toContain("max-h-36");
    expect(words()).toEqual(expect.arrayContaining([STARTED, FAILED]));
    expect(screen.queryByText(/Tasma downloads the skill/)).toBeNull();

    stub.replies[INSTALL] = heldBack().reply;
    await userEvent.click(again);

    expect(screen.queryByRole("group", { name: OUTPUT_LINE })).toBeNull();
    expect(installBodies(stub)).toEqual([{}, {}]);
  });

  it("goes from Try again to the Copy of the output and then to the output box with Shift+Tab", async () => {
    await openFailed();

    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy" }));

    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: OUTPUT_LINE }));
  });

  it("copies the output, and describes its Copy by the line above the output", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const writeText = vi.fn(() => Promise.resolve());

    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const { stub } = await openAnswered(SKILL_AND_PROJECT);

    stub.replies[INSTALL] = successReply({ result: "failed", output: OUTPUT });
    await user.click(installButton());
    await screen.findByRole("button", { name: AGAIN_WORDS });

    const copy = screen.getByRole("button", { name: "Copy" });

    expect(descriptionOf(copy)).toBe(OUTPUT_LINE);

    await user.click(copy);

    expect(writeText).toHaveBeenCalledWith(OUTPUT);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(words()).toContain("Copied");

    await advance(1600);

    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("selects the output when the copy fails, and says how to copy it", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: () => Promise.reject(new Error("not allowed")) } });
    await openFailed();

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Cannot copy" })).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe(OUTPUT);
    expect(words()).toContain("Cannot copy. The output is selected. Press Command-C to copy it.");
  });

  it("shows the two plugin commands after npx-missing, with a plain Try again", async () => {
    const stub = await openNoNpx();
    const again = installButton(AGAIN_WORDS);

    expect(again.className).toContain("bg-surface-2");
    expect(again.className).not.toContain("bg-text");
    expect(document.activeElement).toBe(again);
    expect(screen.getByRole("button", { name: `${SKILL}, Cannot install` })).toBeTruthy();
    expect(screen.getByText(/, which comes with Node\.js\./).textContent).toBe("Tasma cannot find npx, which comes with Node.js.");
    expect(screen.getByText("To install the skill as a Claude Code plugin, run these commands in Claude Code:")).toBeTruthy();
    expect(screen.getByText(FIRST_COMMAND)).toBeTruthy();
    expect(screen.getByText(SECOND_COMMAND)).toBeTruthy();
    expect(screen.getByText("Or install Node.js, and then select \"Try again\".")).toBeTruthy();
    expect(words()).toEqual(expect.arrayContaining([STARTED, NO_NPX]));

    const held = heldBack();

    stub.replies[INSTALL] = held.reply;
    await userEvent.click(again);

    expect(screen.queryByText(FIRST_COMMAND)).toBeNull();
    expect(installBodies(stub)).toEqual([{}, {}]);
    expect(again.className).toContain("bg-text");
  });

  it("numbers the two plugin commands as the items of one list, outside the text of each command", async () => {
    await openNoNpx();

    const list = screen.getByText(FIRST_COMMAND).closest("ol")!;
    const items = within(list).getAllByRole("listitem");

    expect(list.getAttribute("role")).toBe("list");
    expect(items.map((item) => item.querySelector("code")!.textContent)).toEqual([FIRST_COMMAND, SECOND_COMMAND]);
    expect(items.map((item) => item.firstElementChild!.className)).toEqual([
      expect.stringMatching(/before:text-dim .*before:content-\['1'\]/),
      expect.stringMatching(/before:text-dim .*before:content-\['2'\]/),
    ]);
  });

  it("describes each Copy of a command box by its command", async () => {
    await openNoNpx();

    const copies = screen.getAllByRole("button", { name: "Copy" });

    expect(copies.map(descriptionOf)).toEqual([FIRST_COMMAND, SECOND_COMMAND]);
  });

  it("says the end of the write with step 4 collapsed", async () => {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);
    const held = heldBack();

    await press(stub, held.reply);
    await userEvent.click(trigger(SKILL));
    expect(isOpen(SKILL)).toBe(false);

    await act(async () => {
      held.answer(successReply({ result: "failed", output: OUTPUT }));
    });
    await waitFor(() => {
      expect(words()).toContain(FAILED);
    });
    expect(screen.getByRole("button", { name: `${SKILL}, Cannot install` })).toBeTruthy();

    await userEvent.click(trigger(SKILL));
    expect(screen.getByRole("group", { name: OUTPUT_LINE })).toBeTruthy();
  });

  it("says the end of the write with step 5 open", async () => {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);
    const held = heldBack();

    await press(stub, held.reply);
    await userEvent.click(trigger("Add a project"));

    await act(async () => {
      held.answer(successReply({ result: "npx-missing" }));
    });
    await waitFor(() => {
      expect(words()).toContain(NO_NPX);
    });
    expect(isOpen("Add a project")).toBe(true);
    expect(isOpen(SKILL)).toBe(false);
  });

  it("keeps the panel open by hand while step 4 shows a result", async () => {
    const stub = await openFailed();

    (document.activeElement as HTMLElement).blur();
    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" }, { loggedIn: "fail", skill: "fail" })));

    expect(trigger("Log in to Claude Code").getAttribute("aria-current")).toBe("step");
    expect(isOpen(SKILL)).toBe(true);
    expect(screen.getByRole("group", { name: OUTPUT_LINE })).toBeTruthy();
  });

  it("says no end of the write and shows no result after Stop checking for the skill during the run", async () => {
    const stub = stubTransport({
      [START]: successReply(startOf(SKILL_AND_PROJECT)),
      [FULL]: successReply(SKILL_AND_PROJECT),
      [FULL_SKIPPED]: successReply(setupStatus({ project: "fail", workflow: "fail" }, { skill: "not-run" })),
    });
    const held = heldBack();

    await renderWithRouter("/", stub.transport);
    await waitFor(() => {
      expect(isOpen(SKILL)).toBe(true);
    });
    await press(stub, held.reply);
    await userEvent.click(screen.getByRole("button", { name: "Stop checking for the skill" }));

    expect(screen.getByRole("button", { name: `${SKILL}, Not checked` })).toBeTruthy();

    said = [];
    await act(async () => {
      held.answer(successReply({ result: "failed", output: OUTPUT }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: `${SKILL}, Not checked` })).toBeTruthy();
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });

    expect(words()).toEqual([]);
    expect(screen.queryByText(OUTPUT_LINE)).toBeNull();
  });

  it("goes to Done with no words about a failure when the status read after failed shows pass", async () => {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);

    stub.replies[FULL] = successReply(ONLY_PROJECT);
    said = [];
    await press(stub, successReply({ result: "failed", output: OUTPUT }));

    await waitFor(() => {
      expect(screen.getByText(SKILL).closest("button")).toBeNull();
    });
    expect(words()).not.toContain(FAILED);
    expect(screen.queryByText(OUTPUT_LINE)).toBeNull();
  });

  it("does not show the old result when the check fails again after Done", async () => {
    const stub = await openFailed();

    await nextAnswer(stub, successReply(ONLY_PROJECT));
    expect(screen.getByText(SKILL).closest("button")).toBeNull();

    await nextAnswer(stub, successReply(SKILL_AND_PROJECT));
    await userEvent.click(trigger(SKILL));

    expect(screen.getByRole("button", { name: `${SKILL}, Tasma does this` })).toBeTruthy();
    expect(installButton()).toBeTruthy();
    expect(screen.queryByText(OUTPUT_LINE)).toBeNull();
  });

  it("shows the install button again when the read after installed still fails", async () => {
    const { stub } = await openAnswered(SKILL_AND_PROJECT);

    stub.replies[FULL] = REFUSED;
    await press(stub, successReply({ result: "installed" }));

    await screen.findByText(READ_FAILED);
    await waitFor(() => {
      expect(installButton()).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: `${SKILL}, Tasma does this` })).toBeTruthy();
  });

  it("opens the write notice on a transport failure, shows the install button and says nothing more", async () => {
    useNoticeStore.setState({ notices: [], dismissed: new Map() });

    const { stub } = await openAnswered(SKILL_AND_PROJECT);

    said = [];
    await press(stub, { status: 502 });

    await waitFor(() => {
      expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["Cannot install the skill"]);
    });
    expect(useNoticeStore.getState().notices[0]!.line).toContain("The install can still run.");
    expect(installButton()).toBeTruthy();
    expect(screen.getByRole("button", { name: `${SKILL}, Tasma does this` })).toBeTruthy();
    expect(words()).toHaveLength(2);
    expect(words()[0]).toBe(STARTED);
    expect(words()[1]).toMatch(/^Cannot install the skill\. /);
    useNoticeStore.setState({ notices: [], dismissed: new Map() });
  });

  describe("the notice of a failed write", () => {
    const SKIPPED_ANSWER = successReply(setupStatus({ project: "fail", workflow: "fail" }, { skill: "not-run" }));

    function noticeTitles(): string[] {
      return useNoticeStore.getState().notices.map(({ title }) => title);
    }

    /**
     * A read after this comes from the interval: in jsdom, a window focus event
     * breaks the toast viewport of the open notice.
     */
    async function failByTransport(status: SetupStatus = SKILL_AND_PROJECT) {
      const opened = await openAnswered(status);

      await press(opened.stub, { status: 502 });
      await waitFor(() => {
        expect(noticeTitles()).toEqual(["Cannot install the skill"]);
      });

      return opened;
    }

    beforeEach(() => {
      useNoticeStore.setState({ notices: [], dismissed: new Map() });
    });

    afterEach(() => {
      useNoticeStore.setState({ notices: [], dismissed: new Map() });
    });

    it("closes when step 4 changes to Done", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { stub } = await failByTransport();

      stub.replies[FULL] = successReply(ONLY_PROJECT);
      await advance(5000);

      await waitFor(() => {
        expect(screen.getByText(SKILL).closest("button")).toBeNull();
      });
      expect(noticeTitles()).toEqual([]);
    });

    it("closes on Stop checking for the skill", async () => {
      const { stub } = await failByTransport();

      stub.replies[FULL_SKIPPED] = SKIPPED_ANSWER;
      await userEvent.click(screen.getByRole("button", { name: "Stop checking for the skill" }));

      expect(noticeTitles()).toEqual([]);
    });

    it("closes when step 4 changes to Done and the screen closes", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { stub, router } = await failByTransport(ONLY_SKILL);

      stub.replies[FULL] = successReply(setupStatus());
      await advance(5000);
      await advance(1000);
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/tasks");
      });

      expect(noticeTitles()).toEqual([]);
    });

    it("does not open when the write fails after Stop checking for the skill", async () => {
      const { stub } = await openAnswered(SKILL_AND_PROJECT);
      const held = heldBack();

      stub.replies[FULL_SKIPPED] = SKIPPED_ANSWER;
      await press(stub, held.reply);
      await userEvent.click(screen.getByRole("button", { name: "Stop checking for the skill" }));

      await act(async () => {
        held.answer({ status: 502 });
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      });

      expect(screen.getByRole("button", { name: `${SKILL}, Not checked` })).toBeTruthy();
      expect(noticeTitles()).toEqual([]);
    });
  });

  it("does not show the old result when the check fails again before the screen closes", async () => {
    const { stub } = await openAnswered(ONLY_SKILL);

    await press(stub, successReply({ result: "failed", output: OUTPUT }));
    await screen.findByRole("button", { name: AGAIN_WORDS });
    await nextAnswer(stub, successReply(setupStatus()));
    await nextAnswer(stub, successReply(ONLY_SKILL));

    expect(screen.getByRole("button", { name: `${SKILL}, Tasma does this` })).toBeTruthy();
  });
});

describe("adding the project and the workflow", () => {
  const CREATE = "POST /projects";
  const INSTALL_DEV = "POST /workflows/dev/install";
  const EDIT = "PATCH /projects/ORBI";
  const FOLDER = "/Users/sample/code/orbit-notes";
  const ORBIT = { tag: "ORBI", name: "orbit-notes", path: FOLDER, config: {}, live: true };
  const DEV_FOLDER = "/Users/sample/tasma-workflows/dev";
  const INSTALLED = successReply({ result: "installed", folder: DEV_FOLDER });
  const TAKEN = refusalReply(409, { kind: "store", code: "path-taken", message: "this path is not free", path: DEV_FOLDER });
  const GONE = refusalReply(404, { kind: "store", code: "project-not-found", message: "no project ORBI" });
  const PROJECT_NEEDED = setupStatus({ project: "fail", workflow: "fail" });
  const WORKFLOW_NEEDED = setupStatus({ workflow: "fail" });
  const SKILL = "Install the tasma skill in Claude Code";
  const PROJECT_STARTED = "Tasma adds the project.";
  const WORKFLOW_STARTED = "Tasma adds the workflow to orbit-notes.";
  const WORKFLOW_FAILED = "Tasma cannot add the workflow. store/path-taken · this path is not free";
  const SHOWN = "Step 6 shows the reason and a Try again button.";
  const OPEN_IT = "Open step 6 to read the reason and to try again.";
  const LIST_FAILED = "Tasma cannot read your projects. It tries again every 5 seconds.";

  function writes(stub: ReturnType<typeof stubTransport>): { key: string; body: unknown }[] {
    return stub.requests
      .filter(({ method }) => method !== "GET")
      .map(({ method, path, body }) => ({ key: `${method} ${path}`, body }));
  }

  function button(name: string): HTMLElement {
    return screen.getByRole("button", { name });
  }

  function isDone(name: string): boolean {
    return screen.getByText(name).closest("button") === null;
  }

  /** A reply that no daemon gives: the request reaches nothing. */
  function noDaemon(): Promise<TransportReply> {
    const reply = Promise.reject(new Error("connection refused"));

    reply.catch(() => {});
    return reply;
  }

  /** Opens the screen with replies for the writes, and presses "Choose folder" with a pick of `folder`. */
  async function pickWith(
    status: SetupStatus,
    replies: Record<string, TransportReply | Promise<TransportReply>>,
    folder = FOLDER,
  ) {
    const opened = await openAnswered(status);

    Object.assign(opened.stub.replies, replies);
    dialog.pick.mockResolvedValue(folder);
    said = [];
    await userEvent.click(button("Choose folder"));

    return opened;
  }

  async function openWithList(list: TransportReply | Promise<TransportReply>, status = WORKFLOW_NEEDED) {
    const stub = stubTransport({ [START]: successReply(startOf(status)), [FULL]: successReply(status), "/projects": list });

    await renderWithRouter("/", stub.transport);
    await waitFor(() => {
      expect(screen.getByText(/of 6 done/)).toBeTruthy();
    });

    return stub;
  }

  it("creates the project from the folder, installs dev, lists it on the project and closes the screen", async () => {
    const { stub, router } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: INSTALLED,
      [EDIT]: successReply(ORBIT),
      [FULL]: successReply(setupStatus()),
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    }, { timeout: 3000 });
    expect(writes(stub)).toEqual([
      { key: CREATE, body: { path: FOLDER } },
      { key: INSTALL_DEV, body: {} },
      { key: EDIT, body: { workflows: ["dev"] } },
    ]);
    expect(dialog.pick).toHaveBeenCalledTimes(1);
    expect(words().slice(0, 2)).toEqual([PROJECT_STARTED, WORKFLOW_STARTED]);
  });

  it("gives a folder name with no Latin letter the tag PROJ, with no question", async () => {
    const first = heldBack();
    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: first.reply,
      [INSTALL_DEV]: INSTALLED,
      "PATCH /projects/PROJ": successReply({ ...ORBIT, tag: "PROJ", name: "日記" }),
      [FULL]: successReply(WORKFLOW_NEEDED),
    });

    stub.replies[CREATE] = successReply({ ...ORBIT, tag: "PROJ", name: "日記" });
    await act(async () => {
      first.answer(refusalReply(422, { kind: "store", code: "tag-not-generated", message: "the folder name gives no tag" }));
    });
    await waitFor(() => {
      expect(writes(stub).map(({ key }) => key)).toEqual([CREATE, CREATE, INSTALL_DEV, "PATCH /projects/PROJ"]);
    });

    expect(writes(stub)[1]!.body).toEqual({ path: FOLDER, tag: "PROJ" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the tag of a created project with no name", async () => {
    await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply({ tag: "PROJ", path: "/", config: {}, live: true }),
      [INSTALL_DEV]: heldBack().reply,
      [FULL]: heldBack().reply,
    }, "/");

    await screen.findByRole("button", { name: "Adding workflow" });
    expect(screen.getByText(/^Tasma adds a default development workflow to/).textContent)
      .toBe("Tasma adds a default development workflow to PROJ. You can change it later.");
    expect(words()).toContain("Tasma adds the workflow to PROJ.");
  });

  it("lists the dev that exists on the project", async () => {
    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: successReply({ result: "exists" }),
      [EDIT]: successReply(ORBIT),
      [FULL]: successReply(WORKFLOW_NEEDED),
    });

    await waitFor(() => {
      expect(writes(stub).map(({ key }) => key)).toEqual([CREATE, INSTALL_DEV, EDIT]);
    });
    expect(writes(stub)[2]!.body).toEqual({ workflows: ["dev"] });
  });

  it("shows a spinner while the dialog is open and while the project is added, and keeps focus on the one button", async () => {
    const { stub } = await openAnswered(PROJECT_NEEDED);
    const create = heldBack();
    const choose = button("Choose folder");
    let picked: (path: string | null) => void = () => {};

    dialog.pick.mockReturnValue(new Promise((resolve) => {
      picked = resolve;
    }));
    stub.replies[CREATE] = create.reply;
    said = [];
    await userEvent.click(choose);

    expect(choose.getAttribute("aria-disabled")).toBe("true");
    expect(choose.querySelector("svg.animate-spin.motion-reduce\\:animate-none[aria-hidden=\"true\"]")).not.toBeNull();
    expect(document.activeElement).toBe(choose);

    await userEvent.click(choose);
    expect(dialog.pick).toHaveBeenCalledTimes(1);

    await act(async () => {
      picked(FOLDER);
    });

    expect(button("Adding project")).toBe(choose);
    expect(choose.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(choose);
    expect(words()).toEqual([PROJECT_STARTED]);

    await userEvent.click(choose);
    expect(writes(stub)).toHaveLength(1);

    await act(async () => {
      create.answer(refusalReply(422, { kind: "store", code: "path-invalid", message: "this path names no directory", path: FOLDER }));
    });

    expect(await screen.findByRole("button", { name: "Choose folder" })).toBe(choose);
    expect(document.activeElement).toBe(choose);
  });

  it("writes nothing and says nothing on Cancel, and leaves the row in its start state", async () => {
    const { stub } = await openAnswered(PROJECT_NEEDED);

    dialog.pick.mockResolvedValue(null);
    said = [];
    await userEvent.click(button("Choose folder"));

    expect(writes(stub)).toEqual([]);
    expect(words()).toEqual([]);
    expect(button("Choose folder").getAttribute("aria-disabled")).toBe("false");
    expect(button("Choose folder").hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows the failure of the dialog, opens the dialog again, and removes the failure on Cancel", async () => {
    const { stub } = await openAnswered(PROJECT_NEEDED);

    dialog.pick.mockRejectedValue(new FolderDialogError("The app did not answer the folder request."));
    said = [];
    await userEvent.click(button("Choose folder"));

    const choose = button("Choose folder");
    const line = "Select \"Choose folder\" to try again. If the dialog does not open, restart Tasma.";

    expect(screen.getByText("Tasma cannot open the folder dialog.").className).toContain("text-signal");
    expect(descriptionOf(choose)).toBe(`Tasma cannot open the folder dialog. | ${line}`);
    expect(words()).toEqual([`Tasma cannot open the folder dialog. ${line}`]);
    expect(document.activeElement).toBe(choose);

    dialog.pick.mockResolvedValue(null);
    await userEvent.click(choose);

    expect(dialog.pick).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Tasma cannot open the folder dialog.")).toBeNull();
    expect(writes(stub)).toEqual([]);
  });

  it("shows a refused path with its Copy, and opens the dialog again", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: () => Promise.reject(new Error("not allowed")) } });

    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: refusalReply(422, { kind: "store", code: "path-invalid", message: "this path names no directory", path: FOLDER }),
    });
    const choose = await screen.findByRole("button", { name: "Choose folder" });

    await waitFor(() => {
      expect(screen.getByText("store/path-invalid · this path names no directory")).toBeTruthy();
    });
    expect(descriptionOf(choose))
      .toBe(`Tasma cannot add the project. | store/path-invalid · this path names no directory | ${FOLDER}`);
    expect(words()).toEqual([PROJECT_STARTED, "Tasma cannot add the project. store/path-invalid · this path names no directory"]);

    const copy = button("Copy");

    expect(descriptionOf(copy)).toBe(FOLDER);
    await userEvent.click(copy);
    expect(await screen.findByRole("button", { name: "Cannot copy" })).toBeTruthy();
    expect(words()).toContain("Cannot copy. The path is selected. Press Command-C to copy it.");

    dialog.pick.mockResolvedValue("/Users/sample/code/orbit");
    stub.replies[CREATE] = heldBack().reply;
    await userEvent.click(choose);

    expect(dialog.pick).toHaveBeenCalledTimes(2);
    expect(writes(stub).map(({ body }) => body)).toEqual([{ path: FOLDER }, { path: "/Users/sample/code/orbit" }]);
    expect(screen.queryByText(/store\/path-invalid/)).toBeNull();
  });

  it("sends the same path again on Try again after no answer, and changes to Done when a read sees the project", async () => {
    const { stub } = await pickWith(PROJECT_NEEDED, { [CREATE]: noDaemon() });
    const again = await screen.findByRole("button", { name: "Try again" });
    const line = "The daemon did not answer. If the project was added, this step changes to Done.";

    expect(screen.getByText(line)).toBeTruthy();
    expect(words()).toEqual([PROJECT_STARTED, `Tasma cannot add the project. ${line}`]);

    stub.replies[CREATE] = refusalReply(409, { kind: "store", code: "path-taken", message: "project ORBI holds this directory", path: FOLDER });
    await userEvent.click(again);

    await screen.findByText("store/path-taken · project ORBI holds this directory");
    expect(dialog.pick).toHaveBeenCalledTimes(1);
    expect(writes(stub).map(({ body }) => body)).toEqual([{ path: FOLDER }, { path: FOLDER }]);

    await nextAnswer(stub, successReply(WORKFLOW_NEEDED));

    expect(isDone("Add a project")).toBe(true);
    expect(trigger("Add a workflow").textContent).toContain("Tasma does this");
  });

  it("puts the address in the box when the answer is not the daemon's", async () => {
    await pickWith(PROJECT_NEEDED, { [CREATE]: { status: 502 } });
    const again = await screen.findByRole("button", { name: "Try again" });

    expect(descriptionOf(again)).toMatch(
      /^Tasma cannot add the project\. \| The daemon did not answer through the address below\. .* \| .*HTTP 502/,
    );
  });

  it("changes step 5 to Done before a status read answers, starts the workflow write, and starts no second pick", async () => {
    const read = heldBack();
    const install = heldBack();
    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: install.reply,
      [FULL]: read.reply,
    });

    await waitFor(() => {
      expect(isDone("Add a project")).toBe(true);
    });

    expect(screen.queryByRole("button", { name: "Choose folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add workflow" })).toBeNull();
    expect(button("Adding workflow").getAttribute("aria-disabled")).toBe("true");
    expect(trigger("Add a workflow").getAttribute("aria-label")).toBe("Add a workflow, In progress");
    expect(screen.getByText("orbit-notes").className).toContain("font-medium");
    expect(writes(stub).map(({ key }) => key)).toEqual([CREATE, INSTALL_DEV]);
    expect(words()).toEqual([PROJECT_STARTED, WORKFLOW_STARTED, "Add a project: done."]);
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger("Add a workflow"));
    });

    await userEvent.click(button("Adding workflow"));
    expect(writes(stub)).toHaveLength(2);

    stub.replies[EDIT] = successReply(ORBIT);
    await act(async () => {
      install.answer(INSTALLED);
    });

    expect(button("Adding workflow")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add workflow" })).toBeNull();
    expect(writes(stub).map(({ key }) => key)).toEqual([CREATE, INSTALL_DEV, EDIT]);

    await act(async () => {
      read.answer(successReply(setupStatus({}, { skill: "fail" })));
    });
    await waitFor(() => {
      expect(isDone("Add a workflow")).toBe(true);
    });
  });

  it("starts the workflow write when a status read sees the project before the create answers", async () => {
    const create = heldBack();
    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: create.reply,
      [INSTALL_DEV]: heldBack().reply,
      "/projects": successReply([ORBIT]),
    });

    await nextAnswer(stub, successReply(WORKFLOW_NEEDED));

    expect(isDone("Add a project")).toBe(true);
    expect(button("Adding workflow").getAttribute("aria-disabled")).toBe("true");
    expect(trigger("Add a workflow").getAttribute("aria-label")).toBe("Add a workflow, In progress");

    await act(async () => {
      create.answer(successReply(ORBIT));
    });

    await waitFor(() => {
      expect(writes(stub).map(({ key }) => key)).toEqual([CREATE, INSTALL_DEV]);
    });
    expect(button("Adding workflow")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add workflow" })).toBeNull();
    expect(words()).toContain(WORKFLOW_STARTED);
  });

  it("drops a failed create when a status read saw the project first, and says nothing", async () => {
    const create = heldBack();
    const { stub } = await pickWith(PROJECT_NEEDED, { [CREATE]: create.reply, "/projects": successReply([ORBIT]) });

    await nextAnswer(stub, successReply(WORKFLOW_NEEDED));
    said = [];
    await act(async () => {
      create.answer({ status: 502 });
    });

    expect(await screen.findByRole("button", { name: "Add workflow" })).toBeTruthy();
    expect(words()).toEqual([]);
    expect(writes(stub).map(({ key }) => key)).toEqual([CREATE]);

    await nextAnswer(stub, successReply(PROJECT_NEEDED));
    await userEvent.click(trigger("Add a project"));

    expect(button("Choose folder")).toBeTruthy();
    expect(screen.queryByText(/Tasma cannot add/)).toBeNull();
  });

  it("shows a failed install in step 6 before a status read answers, keeps the project, and succeeds on Try again", async () => {
    const read = heldBack();
    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: TAKEN,
      [FULL]: read.reply,
    });
    const again = await screen.findByRole("button", { name: "Try again" });

    expect(trigger("Add a workflow").getAttribute("aria-label")).toBe("Add a workflow, Cannot add");
    expect(isDone("Add a project")).toBe(true);
    expect(descriptionOf(again)).toBe(`Tasma cannot add the workflow. | store/path-taken · this path is not free | ${DEV_FOLDER}`);
    expect(words()).toEqual([PROJECT_STARTED, WORKFLOW_STARTED, "Add a project: done.", `${WORKFLOW_FAILED} ${SHOWN}`]);
    expect(writes(stub).map(({ key }) => key)).toEqual([CREATE, INSTALL_DEV]);

    await act(async () => {
      read.answer(successReply(WORKFLOW_NEEDED));
    });
    stub.replies[INSTALL_DEV] = INSTALLED;
    stub.replies[EDIT] = successReply(ORBIT);
    stub.replies[FULL] = successReply(setupStatus({}, { skill: "fail" }));
    said = [];
    await userEvent.click(again);

    expect(screen.queryByText(/store\/path-taken/)).toBeNull();
    await waitFor(() => {
      expect(isDone("Add a workflow")).toBe(true);
    });
    expect(writes(stub).map(({ key }) => key)).toEqual([CREATE, INSTALL_DEV, INSTALL_DEV, EDIT]);
    expect(words()).toEqual([WORKFLOW_STARTED, "Add a workflow: done."]);
  });

  it("shows a failed edit after the install", async () => {
    await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: INSTALLED,
      [EDIT]: refusalReply(422, { kind: "store", code: "workflow-invalid", message: "dev does not load" }),
      [FULL]: successReply(WORKFLOW_NEEDED),
    });

    expect(await screen.findByText("store/workflow-invalid · dev does not load")).toBeTruthy();
    expect(button("Try again")).toBeTruthy();
  });

  it("returns step 5 to its start state when a later status gives project fail", async () => {
    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: TAKEN,
      [FULL]: successReply(WORKFLOW_NEEDED),
    });

    await screen.findByRole("button", { name: "Try again" });
    await nextAnswer(stub, successReply(PROJECT_NEEDED));

    expect(trigger("Add a project").getAttribute("aria-label")).toBe("Add a project, You do this");
    expect(trigger("Add a workflow").getAttribute("aria-label")).toBe("Add a workflow, Tasma does this");

    await userEvent.click(trigger("Add a project"));

    expect(button("Choose folder")).toBeTruthy();
    expect(screen.queryByText(/Tasma cannot add/)).toBeNull();
  });

  it("clears the project after project-not-found, and Try again waits for the list", async () => {
    const list = heldBack();
    const { stub } = await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: INSTALLED,
      [EDIT]: GONE,
      [FULL]: successReply(WORKFLOW_NEEDED),
      "/projects": list.reply,
    });
    const reading = await screen.findByRole("button", { name: "Reading projects" });

    expect(reading.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/^Tasma adds a default development workflow to/).textContent).toContain("to your project.");
    expect(descriptionOf(reading)).toBe("Tasma cannot add the workflow. | store/project-not-found · no project ORBI");
    expect(trigger("Add a workflow").getAttribute("aria-label")).toBe("Add a workflow, Cannot add");

    await userEvent.click(reading);
    expect(writes(stub)).toHaveLength(3);

    stub.replies[INSTALL_DEV] = successReply({ result: "exists" });
    stub.replies["PATCH /projects/ORBIT"] = successReply({ ...ORBIT, tag: "ORBIT" });
    await act(async () => {
      list.answer(successReply([{ tag: "ORBIT", name: "orbit-notes", path: FOLDER }]));
    });
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(writes(stub).at(-1)).toEqual({ key: "PATCH /projects/ORBIT", body: { workflows: ["dev"] } });
    });
  });

  it("says only the failure when project-not-found returns step 5 to its start state", async () => {
    await pickWith(PROJECT_NEEDED, {
      [CREATE]: successReply(ORBIT),
      [INSTALL_DEV]: INSTALLED,
      [EDIT]: GONE,
      [FULL]: heldBack().reply,
    });

    await waitFor(() => {
      expect(words()).toContain("Tasma cannot add the workflow. store/project-not-found · no project ORBI");
    });
    expect(trigger("Add a project").getAttribute("aria-label")).toBe("Add a project, You do this");
    expect(isOpen("Add a workflow")).toBe(false);
  });

  describe("with no project from this session", () => {
    const ALPHA = { tag: "ALPHA", name: "alpha-notes", path: "/Users/sample/code/alpha-notes" };
    const BETA = { tag: "BETA", name: "beta-notes", path: "/Users/sample/code/beta-notes" };

    it("names the first project, waits for a press and attaches dev only to that project", async () => {
      const list = heldBack();
      const stub = await openWithList(list.reply);
      const reading = await screen.findByRole("button", { name: "Reading projects" });

      expect(reading.getAttribute("aria-disabled")).toBe("true");
      expect(reading.hasAttribute("aria-describedby")).toBe(false);
      expect(screen.getByText(/^Tasma adds a default development workflow to/).textContent)
        .toBe("Tasma adds a default development workflow to your project. You can change it later.");

      await act(async () => {
        list.answer(successReply([ALPHA, BETA]));
      });

      const add = await screen.findByRole("button", { name: "Add workflow" });

      expect(add).toBe(reading);
      expect(add.getAttribute("aria-disabled")).toBe("false");
      expect(descriptionOf(add)).toBe("Tasma adds a default development workflow to alpha-notes. You can change it later.");
      expect(trigger("Add a workflow").getAttribute("aria-label")).toBe("Add a workflow, Tasma does this");
      expect(writes(stub)).toEqual([]);

      stub.replies[INSTALL_DEV] = INSTALLED;
      stub.replies["PATCH /projects/ALPHA"] = successReply(ALPHA);
      said = [];
      await userEvent.click(add);

      await waitFor(() => {
        expect(writes(stub)).toEqual([
          { key: INSTALL_DEV, body: {} },
          { key: "PATCH /projects/ALPHA", body: { workflows: ["dev"] } },
        ]);
      });
      expect(words()[0]).toBe("Tasma adds the workflow to alpha-notes.");
      expect(document.activeElement).toBe(add);
    });

    it("reads the list again after project-not-found, and Try again sends the tag of the new first project", async () => {
      const stub = await openWithList(successReply([ALPHA]));

      stub.replies[INSTALL_DEV] = INSTALLED;
      stub.replies["PATCH /projects/ALPHA"] = refusalReply(404, { kind: "store", code: "project-not-found", message: "no project ALPHA" });
      stub.replies["/projects"] = successReply([BETA]);
      await userEvent.click(await screen.findByRole("button", { name: "Add workflow" }));

      await screen.findByText("beta-notes");
      stub.replies["PATCH /projects/BETA"] = successReply(BETA);
      await userEvent.click(button("Try again"));

      await waitFor(() => {
        expect(writes(stub).at(-1)).toEqual({ key: "PATCH /projects/BETA", body: { workflows: ["dev"] } });
      });
    });

    it("names the tag of a project with no name", async () => {
      await openWithList(successReply([{ tag: "ALPHA" }]));

      await screen.findByRole("button", { name: "Add workflow" });
      expect(screen.getByText("ALPHA").className).toContain("font-medium");
    });

    it("shows and says a failed list read one time, and removes the line after a read that succeeds", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const stub = await openWithList(refusalReply(500, { kind: "daemon", code: "internal", message: "the list broke" }));

      await screen.findByText(LIST_FAILED);

      const reading = button("Reading projects");

      expect(descriptionOf(reading)).toBe(LIST_FAILED);
      expect(words().filter((spoken) => spoken === LIST_FAILED)).toHaveLength(1);

      await advance(5000);
      expect(words().filter((spoken) => spoken === LIST_FAILED)).toHaveLength(1);

      stub.replies["/projects"] = successReply([ALPHA]);
      await advance(5000);

      await waitFor(() => {
        expect(screen.queryByText(LIST_FAILED)).toBeNull();
      });
      expect(button("Add workflow")).toBe(reading);
    });

    it("reads the list again every 5 seconds while it holds no project", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const stub = await openWithList(successReply([]));
      const reads = countReads(stub, "/projects");

      await screen.findByRole("button", { name: "Reading projects" });
      await advance(5000);
      expect(reads()).toBe(1);

      stub.replies["/projects"] = successReply([ALPHA]);
      await advance(5000);
      await screen.findByRole("button", { name: "Add workflow" });

      await advance(5000);
      expect(reads()).toBe(1);
    });
  });

  describe("a failure of step 6 while steps 1 to 4 are not done", () => {
    const SKILL_AND_PROJECT = setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" });

    /** Opens step 5 by hand, with an install that the test answers after step 5 is done. */
    async function openWithWrites() {
      const opened = await openAnswered(SKILL_AND_PROJECT);
      const install = heldBack();

      Object.assign(opened.stub.replies, { [CREATE]: successReply(ORBIT), [INSTALL_DEV]: install.reply });
      dialog.pick.mockResolvedValue(FOLDER);
      await userEvent.click(trigger("Add a project"));
      said = [];

      return { ...opened, install };
    }

    async function failAfterDone(install: ReturnType<typeof heldBack>): Promise<void> {
      await waitFor(() => {
        expect(isDone("Add a project")).toBe(true);
      });
      await act(async () => {
        install.answer(TAKEN);
      });
    }

    it("leaves step 6 closed after a press with focus on the button, and says to open it", async () => {
      const { install } = await openWithWrites();

      await userEvent.click(button("Choose folder"));
      await waitFor(() => {
        expect(document.activeElement).toBe(trigger(SKILL));
      });
      await failAfterDone(install);

      await waitFor(() => {
        expect(words()).toContain(`${WORKFLOW_FAILED} ${OPEN_IT}`);
      });
      expect(isOpen(SKILL)).toBe(true);
      expect(isOpen("Add a workflow")).toBe(false);
      expect(document.activeElement).toBe(trigger(SKILL));
      expect(trigger("Add a workflow").getAttribute("aria-label")).toBe("Add a workflow, Cannot add");
    });

    it("opens step 6 and scrolls it into view after a press with no focus on the button", async () => {
      const scrollIntoView = stubScrollIntoView();
      const { install } = await openWithWrites();

      screen.getByRole("heading", { level: 1 }).focus();
      fireEvent.click(button("Choose folder"));
      await failAfterDone(install);

      await waitFor(() => {
        expect(words()).toContain(`${WORKFLOW_FAILED} ${SHOWN}`);
      });
      expect(isOpen("Add a workflow")).toBe(true);
      expect(isOpen(SKILL)).toBe(false);
      expect(scrollIntoView.mock.contexts).toEqual([screen.getByText("Add a workflow").closest("li")]);
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    });

    it("keeps open a panel that the user opened", async () => {
      const install = heldBack();
      const stub = await openWithList(
        successReply([{ tag: "ORBI", name: "orbit-notes", path: FOLDER }]),
        setupStatus({ workflow: "fail" }, { skill: "fail" }),
      );

      stub.replies[INSTALL_DEV] = install.reply;
      await waitFor(() => {
        expect(isOpen(SKILL)).toBe(true);
      });
      await userEvent.click(trigger("Add a workflow"));
      await userEvent.click(await screen.findByRole("button", { name: "Add workflow" }));
      await userEvent.click(trigger(SKILL));
      (document.activeElement as HTMLElement).blur();
      said = [];

      await act(async () => {
        install.answer(TAKEN);
      });

      await waitFor(() => {
        expect(words()).toEqual([`${WORKFLOW_FAILED} ${OPEN_IT}`]);
      });
      expect(isOpen(SKILL)).toBe(true);
      expect(isOpen("Add a workflow")).toBe(false);
    });
  });

  describe("in the browser", () => {
    const FIELD = "Folder path";

    beforeEach(() => {
      dialog.available = false;
    });

    function field(): HTMLElement {
      return screen.getByRole("textbox", { name: FIELD });
    }

    it("takes a trimmed path from the field, and starts the workflow write by itself", async () => {
      const { stub } = await openAnswered(PROJECT_NEEDED);

      Object.assign(stub.replies, {
        [CREATE]: successReply(ORBIT),
        [INSTALL_DEV]: INSTALLED,
        [EDIT]: successReply(ORBIT),
        [FULL]: successReply(WORKFLOW_NEEDED),
      });
      expect(screen.queryByRole("button", { name: "Choose folder" })).toBeNull();

      await userEvent.type(field(), `  ${FOLDER}  {Enter}`);

      await waitFor(() => {
        expect(writes(stub)).toEqual([
          { key: CREATE, body: { path: FOLDER } },
          { key: INSTALL_DEV, body: {} },
          { key: EDIT, body: { workflows: ["dev"] } },
        ]);
      });
      expect(dialog.pick).not.toHaveBeenCalled();
    });

    it("marks the field as required, to a screen reader and with its placeholder", async () => {
      await openAnswered(PROJECT_NEEDED);

      expect(field().getAttribute("aria-required")).toBe("true");
      expect(field().getAttribute("placeholder")).toBe("Required");
      expect(field().className).toContain("placeholder:text-dim");
    });

    it("sends nothing for an empty path, moves focus to the field, and says the words only when focus was there", async () => {
      const { stub } = await openAnswered(PROJECT_NEEDED);
      const empty = "Type the path of a folder.";

      said = [];
      await userEvent.click(button("Add project"));

      expect(screen.getByText(empty)).toBeTruthy();
      expect(document.activeElement).toBe(field());
      expect(document.getElementById(field().getAttribute("aria-describedby")!)?.textContent).toBe(empty);
      expect(words()).toEqual([]);

      await userEvent.type(field(), "   {Enter}");

      expect(words()).toEqual([empty]);
      expect(writes(stub)).toEqual([]);

      await userEvent.type(field(), "x");
      expect(screen.queryByText(empty)).toBeNull();
    });

    it("is busy while the project is added, ignores Enter, and keeps the value and the button after a failure", async () => {
      const { stub } = await openAnswered(PROJECT_NEEDED);
      const create = heldBack();

      stub.replies[CREATE] = create.reply;
      await userEvent.type(field(), `${FOLDER}{Enter}`);

      const adding = button("Adding project");

      expect(adding.getAttribute("aria-disabled")).toBe("true");

      await userEvent.type(field(), "{Enter}");
      await userEvent.click(adding);
      expect(writes(stub)).toHaveLength(1);

      await act(async () => {
        create.answer({ status: 502 });
      });

      expect(await screen.findByRole("button", { name: "Add project" })).toBe(adding);
      expect((field() as HTMLInputElement).value).toBe(FOLDER);
      expect(descriptionOf(adding)).toMatch(/^Tasma cannot add the project\. \| /);
    });
  });
});

describe("focus", () => {
  it("moves to the h1 when the screen opens, with no ring until the h1 loses focus to an element of the page", async () => {
    await openHeld();

    const heading = screen.getByRole("heading", { level: 1 });

    expect(document.activeElement).toBe(heading);
    expect(heading.className).toContain("focus-visible:outline-none");

    fireEvent.blur(heading);
    fireEvent.blur(trigger("Add a project"));
    expect(document.activeElement).toBe(heading);
    expect(heading.className).toContain("focus-visible:outline-none");

    act(() => {
      trigger("Add a project").focus();
    });
    expect(heading.className).not.toContain("focus-visible:outline-none");

    act(() => {
      heading.focus();
    });
    expect(heading.className).not.toContain("focus-visible:outline-none");
  });

  it("keeps the ring of the h1 when a key press came before the screen opens", async () => {
    useUiStore.getState().noteKeyPress();
    await openHeld();

    const heading = screen.getByRole("heading", { level: 1 });

    expect(document.activeElement).toBe(heading);
    expect(heading.className).not.toContain("focus-visible:outline-none");

    act(() => {
      trigger("Add a project").focus();
    });
    expect(heading.className).not.toContain("focus-visible:outline-none");
  });

  it("moves to the trigger of the step when the content of its panel replaces the control", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" }));

    screen.getByRole("button", { name: "Stop checking for the skill" }).focus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger("Install the tasma skill in Claude Code"));
    });
  });

  it("moves to the trigger of the current step when the step that held focus changes to done", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" }));

    trigger("Add a project").focus();
    await nextAnswer(stub, successReply(setupStatus({ workflow: "fail" }, { skill: "fail" })));

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger("Install the tasma skill in Claude Code"));
    });
  });

  it("moves to the h1 when the step that held focus changes to done and no step is current", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "not-run", workflow: "fail" }, { skill: "fail" }));

    trigger("Install the tasma skill in Claude Code").focus();
    await nextAnswer(stub, successReply(setupStatus({ project: "not-run", workflow: "fail" })));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    });
  });

  it("moves to the trigger of the step when the first full answer changes the content", async () => {
    const stub = stubTransport({ [START]: successReply(startOf(NEW_MACHINE)), [FULL]: REFUSED });
    await renderWithRouter("/", stub.transport);

    await waitFor(() => {
      expect(trigger("Install the Claude Code CLI")).toBeTruthy();
    });
    await userEvent.click(trigger("Install the Claude Code CLI"));
    screen.getByRole("button", { name: "Check again" }).focus();
    stub.replies[FULL] = successReply(NEW_MACHINE);
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger("Install the Claude Code CLI"));
    });
  });

  it("stays where it is when no element leaves", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    trigger("Add a workflow").focus();
    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" })));

    expect(document.activeElement).toBe(trigger("Add a workflow"));
  });
});
