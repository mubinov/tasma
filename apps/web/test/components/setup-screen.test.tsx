import type { SetupStatus, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  stubTransport,
  successReply,
} from "../helpers";

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
  window.localStorage.clear();
  setPreferenceStorage(browserPreferenceStorage);
  useUiStore.setState({ skillCheckStopped: false, arrivalWords: null });
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

    expect(document.title).toBe("Set up · tasma");
    expect(document.getElementById(TITLE_COVER_ID)).not.toBeNull();
  });

  it("holds the one h1 in main, with the mark before it as no heading", async () => {
    await openHeld();

    const main = screen.getByRole("main");
    const headings = screen.getAllByRole("heading");

    expect(headings).toHaveLength(1);
    expect(main.contains(headings[0]!)).toBe(true);
    expect(main.contains(screen.getByText("tasma"))).toBe(false);
    expect(screen.getByRole("banner").contains(screen.getByText("tasma"))).toBe(true);
    expect(screen.getByText("Complete these steps to run your first task.")).toBeTruthy();
  });

  it("lists the 6 steps in an ordered list that the heading names", async () => {
    await openAnswered();

    const list = screen.getByRole("list", { name: "Set up Tasma" });

    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(list.textContent).toContain("Install Claude Code");
    expect(list.textContent).toContain("Add a workflow");
    expect(screen.getByText("0 of 6 done")).toBeTruthy();
  });

  it("names a trigger with the step and its label", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    expect(screen.getByRole("button", { name: "Add a project, You do this" })).toBeTruthy();
  });

  it("makes a done step a plain row, outside the Tab order", async () => {
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    expect(screen.queryByRole("button", { name: /^Install Claude Code/ })).toBeNull();
    expect(screen.getByText("Install Claude Code")).toBeTruthy();
    expect(screen.getByText("4 of 6 done")).toBeTruthy();
  });

  it("does not make the name of a step a heading", async () => {
    await openAnswered();

    expect(screen.queryByRole("heading", { name: /Install Claude Code/ })).toBeNull();
  });
});

describe("before the first full answer", () => {
  it("shows steps 1 to 3 in progress, as plain rows", async () => {
    await openHeld();

    expect(screen.getAllByText(CHECK_IN_PROGRESS)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /^Install Claude Code/ })).toBeNull();
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
    expect(screen.getByText("tasma project create --path .")).toBeTruthy();
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

    expect(isOpen("Install Claude Code")).toBe(true);
    expect(screen.getByText("Tasma runs your workflows with Claude Code.")).toBeTruthy();

    const guide = screen.getByRole("link", { name: "Open the Claude Code install guide (opens in the browser)" });

    expect(guide.getAttribute("href")).toBe("https://code.claude.com/docs/en/setup");
    expect(guide.getAttribute("target")).toBe("_blank");

    await userEvent.click(trigger("Log in to Claude Code"));
    expect(screen.getByText("First, complete step 1: Install Claude Code.")).toBeTruthy();

    await userEvent.click(trigger("Add the tasma command"));
    expect(screen.getByText(/macOS asks for your password one time/)).toBeTruthy();
    expect(screen.getByText("Tasma > Install Command Line Tool…")).toBeTruthy();

    await userEvent.click(trigger("Install the tasma skill in Claude Code"));
    expect(screen.getByText("npx skills add mubinov/tasma-skill -g")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Other ways to install the skill (opens in the browser)" }).getAttribute("href"))
      .toBe("https://github.com/mubinov/tasma-skill#install");

    await userEvent.click(trigger("Add a project"));
    expect(screen.getByText("Open a terminal in this folder, and run this command:")).toBeTruthy();
    expect(screen.getByText("tasma project create --path .")).toBeTruthy();

    await userEvent.click(trigger("Add a workflow"));
    expect(screen.getByText("First, complete step 5: Add a project.")).toBeTruthy();
  });

  it("gives step 6 its content when step 5 is done", async () => {
    await openAnswered(setupStatus({ workflow: "fail" }));

    expect(isOpen("Add a workflow")).toBe(true);
    expect(screen.getByText("A workflow gives each task its steps. Ask Claude Code to create a workflow for your project.")).toBeTruthy();
  });
});

describe("the current step", () => {
  it("keeps its mark when it is collapsed", async () => {
    await openAnswered();

    await userEvent.click(trigger("Install Claude Code"));

    expect(isOpen("Install Claude Code")).toBe(false);
    expect(trigger("Install Claude Code").getAttribute("aria-current")).toBe("step");
    expect(trigger("Install Claude Code").querySelector(".bg-signal")).not.toBeNull();
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

    expect(trigger("Install Claude Code").getAttribute("aria-current")).toBe("step");
    expect(within(trigger("Install Claude Code")).getByText("Cannot check").className).toContain("text-dim");
  });
});

describe("opening by itself", () => {
  it("opens one step at a time", async () => {
    await openAnswered();

    await userEvent.click(trigger("Add a project"));

    expect(isOpen("Add a project")).toBe(true);
    expect(isOpen("Install Claude Code")).toBe(false);
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
      expect(trigger("Install Claude Code").getAttribute("aria-current")).toBe("step");
    });

    expect(isOpen("Add a project")).toBe(true);
    expect(isOpen("Install Claude Code")).toBe(false);
  });

  it("keeps a panel that the user opened with Enter while focus stays on its trigger", async () => {
    const { held } = await openHeld();

    trigger("Add a project").focus();
    await userEvent.keyboard("{Enter}");
    await act(async () => {
      held.answer(successReply(NEW_MACHINE));
    });
    await waitFor(() => {
      expect(trigger("Install Claude Code").getAttribute("aria-current")).toBe("step");
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
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: () => Promise.resolve() } });

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
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

    expect(isOpen("Install Claude Code")).toBe(true);
  });

  it("leaves the current step closed when the user closes it", async () => {
    await openAnswered();

    await userEvent.click(trigger("Install Claude Code"));
    expect(isOpen("Install Claude Code")).toBe(false);

    await userEvent.click(trigger("Install Claude Code"));
    expect(isOpen("Install Claude Code")).toBe(true);

    await userEvent.click(trigger("Install Claude Code"));
    expect(isOpen("Install Claude Code")).toBe(false);
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

    expect(screen.getByText("Install Claude Code").closest("li")!.querySelector(".animate-step-done")).toBeNull();
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
    expect(trigger("Install Claude Code").getAttribute("aria-current")).toBe("step");
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
      expect(trigger("Install Claude Code").textContent).toContain("You do this");

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

describe("closing", () => {
  const PROJECT_ONLY = setupStatus({ workflow: "fail" });

  it("goes to the Tasks page 1 second after the triggers pass, with replace", async () => {
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
      held.answer(successReply(setupStatus({ cli: "fail" }, { installed: "fail" })));
    });
    await screen.findByText("4 of 6 done");

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
  function stubClipboard(writeText: (text: string) => Promise<void>): void {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  }

  it("copies the command, and reads Copied for 1.5 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const writeText = vi.fn(() => Promise.resolve());

    stubClipboard(writeText);
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("tasma project create --path .");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(words()).toContain("Copied");

    await advance(1600);

    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("selects the command when the copy fails, and says how to copy it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

    stubClipboard(() => Promise.reject(new Error("not allowed")));
    await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(screen.getByRole("button", { name: "Cannot copy" })).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe("tasma project create --path .");
    expect(words()).toContain("Cannot copy. The command is selected. Press Command-C to copy it.");

    await advance(1600);

    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});

describe("focus", () => {
  it("moves to the h1 when the screen opens", async () => {
    await openHeld();

    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
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
      expect(trigger("Install Claude Code")).toBeTruthy();
    });
    await userEvent.click(trigger("Install Claude Code"));
    screen.getByRole("button", { name: "Check again" }).focus();
    stub.replies[FULL] = successReply(NEW_MACHINE);
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger("Install Claude Code"));
    });
  });

  it("stays where it is when no element leaves", async () => {
    const { stub } = await openAnswered(setupStatus({ project: "fail", workflow: "fail" }));

    trigger("Add a workflow").focus();
    await nextAnswer(stub, successReply(setupStatus({ project: "fail", workflow: "fail" })));

    expect(document.activeElement).toBe(trigger("Add a workflow"));
  });
});
