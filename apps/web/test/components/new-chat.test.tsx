import type { TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_CLIENT } from "../../src/api/mutations";
import { chatDraft, NEW_CHAT_DRAFT, useChatDraftStore } from "../../src/store/chat-drafts";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { projectChatPath, projectChatRecord } from "../chat-daemon";
import {
  itemLink,
  listItem,
  newChatButton,
  pageReply,
  projectItem,
  PROJECTS,
  renderDashboard,
  START_ANSWER,
  START_LOG,
  START_POST,
  START_RECORD,
  startDaemon,
  stubLayout,
  type DashboardStub,
} from "../dashboard-fixtures";
import { heldBack, refusalReply, stubThreadDom, successReply } from "../helpers";
import { stubWindowWidth } from "../setup/match-media";
import { frame } from "../setup/notice-store";
import { spoken } from "../update-fixtures";

const STARTED = "Chat 5 of SAGA started.";

const NEW_ROW = projectItem("SAGA", 5, 0, { title: "Plan the release" });

const OLD_ROW = listItem("ACME-7", 1, 90, { title: "Ship the release" });

const LISTED = pageReply([NEW_ROW, OLD_ROW]);

function field(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message input" });
}

function findField(): Promise<HTMLTextAreaElement> {
  return screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message input" });
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Send message" });
}

function trigger(name: RegExp | string = /^Project/): HTMLElement {
  return within(screen.getByRole("region", { name: "New chat" })).getByRole("button", { name });
}

function viewHeading(): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: "New chat" });
}

function posts(stub: DashboardStub) {
  return stub.requests.filter(({ method }) => method === "POST");
}

function words(line: string): string[] {
  return spoken().filter((said) => said === line);
}

function isDocked(): boolean {
  return document.querySelector(".aui-thread-viewport-footer")!.classList.contains("sticky");
}

/** A project is selected through the filter of the address, so a text is all the view needs. */
const WITH_PROJECT = "/?new=1&project=SAGA";

async function open(path: string, stub = startDaemon(), strict = false) {
  const router = await renderDashboard(stub, path, { strict });
  await findField();
  return { stub, router, user: userEvent.setup() };
}

async function answerLog(stub: DashboardStub): Promise<void> {
  await act(async () => {
    stub.answer(0, START_LOG, 5);
    await Promise.resolve();
  });
}

beforeEach(() => {
  stubThreadDom();
  stubLayout();
  useUiStore.setState({ lastChatProject: null, startedChat: null, chatStartWatch: null, arrivalWords: null });
  useChatDraftStore.setState({ drafts: new Map() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the view", () => {
  it("shows the header, the picker label and the message field, with the focus in the field", async () => {
    await open("/?new=1");

    expect(viewHeading().nextElementSibling?.textContent).toBe("Claude");
    expect(screen.queryByRole("link", { name: "Open task" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Chat menu/ })).toBeNull();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(field().placeholder).toBe("Send a message...");
    expect(document.activeElement).toBe(field());
    expect(isDocked()).toBe(false);
  });

  it.each([
    [WITH_PROJECT, {}, "New chat in SAGA"],
    ["/?new=1", {}, "New chat. Select a project."],
    ["/?new=1", { "/projects": successReply([]) }, "New chat. No projects yet."],
  ])("says the opening of %s after the focus moves", async (path, replies, line) => {
    await open(path, startDaemon(replies));
    await frame();

    expect(words(line)).toHaveLength(1);
  });

  it("takes the focus and says the opening after a navigation from another screen", async () => {
    const stub = startDaemon();
    const router = await renderDashboard(stub, "/settings");

    await act(async () => {
      await router.navigate({ to: "/", search: { new: "1", project: "SAGA" } });
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
    await frame();

    expect(words("New chat in SAGA")).toHaveLength(1);
  });

  it("offers Send only with a project and a text that holds a character", async () => {
    const { user } = await open(WITH_PROJECT);

    expect(sendButton().disabled).toBe(true);
    await user.type(field(), "   ");
    expect(sendButton().disabled).toBe(true);
    await user.type(field(), "Plan");
    expect(sendButton().disabled).toBe(false);
  });

  it("offers no Send with a text and no project", async () => {
    const { user } = await open("/?new=1");

    await user.type(field(), "Plan");

    expect(sendButton().disabled).toBe(true);
  });

  it("sends on Enter", async () => {
    const { user, stub } = await open(WITH_PROJECT);

    await user.type(field(), "Plan the release{Enter}");

    await waitFor(() => {
      expect(posts(stub)).toEqual([
        { method: "POST", path: "/projects/SAGA/chats", body: { text: "Plan the release", client: CHAT_CLIENT } },
      ]);
    });
  });

  it("adds a line on Shift+Enter", async () => {
    const { user, stub } = await open(WITH_PROJECT);

    await user.type(field(), "One{Shift>}{Enter}{/Shift}Two");

    expect(field().value).toBe("One\nTwo");
    expect(posts(stub)).toEqual([]);
  });

  it.each([
    [{}, "Select a project to send the message."],
    [{ "/projects": successReply([]) }, "No projects yet. Add one on the Projects screen."],
  ])("says why Enter with no project sends nothing", async (replies, line) => {
    const { user, stub } = await open("/?new=1", startDaemon(replies));

    await user.type(field(), "Plan{Enter}");
    await frame();

    expect(words(line)).toHaveLength(1);
    expect(document.activeElement).toBe(field());
    expect(posts(stub)).toEqual([]);
  });

  it("says nothing for Enter with an empty field", async () => {
    const { user } = await open("/?new=1");

    await user.type(field(), "{Enter}");
    await frame();

    expect(words("Select a project to send the message.")).toEqual([]);
  });

  it("says nothing for Enter on the Project trigger", async () => {
    const { user } = await open("/?new=1");

    await user.type(field(), "Plan");
    trigger().focus();
    await user.keyboard("{Enter}");
    await frame();

    expect(words("Select a project to send the message.")).toEqual([]);
  });

  it("gives the focus to the message field when a press of Send takes Send away", async () => {
    const { reply } = heldBack();
    const { user } = await open(WITH_PROJECT, startDaemon({ [START_POST]: reply }));

    await user.type(field(), "Plan");
    await user.click(sendButton());

    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
  });

  it("gives the focus to the heading when Chats goes away with the focus", async () => {
    const width = stubWindowWidth("narrow");
    await open("/?new=1");

    within(screen.getByRole("main")).getByRole("link", { name: "Chats" }).focus();
    width.set("wide");

    await waitFor(() => {
      expect(document.activeElement).toBe(viewHeading());
    });
  });

  it("keeps the draft when the view closes and opens again", async () => {
    const { user } = await open("/?new=1");

    await user.type(field(), "Plan the release");
    await user.click(itemLink("ACME-7", 1));
    await screen.findByRole("heading", { level: 2, name: /^ACME-7/ });
    await user.click(newChatButton());

    await waitFor(() => {
      expect(field().value).toBe("Plan the release");
    });
    expect(document.activeElement).toBe(field());
  });
});

describe("the selected project", () => {
  it.each([
    ["the project of the filter", "/?new=1&project=SAGA", null, "Project Saga SAGA"],
    ["the last project, with no filter", "/?new=1", "ACME", "Project Acme ACME"],
  ])("selects %s", async (_name, path, last, name) => {
    useUiStore.setState({ lastChatProject: last });

    await open(path);

    expect(trigger(name)).toBeTruthy();
  });

  it.each([
    ["a filter project with no folder", "/?new=1&project=DUNE", "ACME"],
    ["a last project that is not in the list", "/?new=1", "GONE"],
    ["a last project with no folder", "/?new=1", "DUNE"],
    ["no last project", "/?new=1", null],
  ])("selects nothing for %s", async (_name, path, last) => {
    useUiStore.setState({ lastChatProject: last });

    await open(path);

    expect(within(trigger()).getByText("Select a project").className).toContain("text-signal");
  });

  it("offers each project, and a project with no folder as a disabled item", async () => {
    const { user } = await open("/?new=1");

    await user.click(trigger());
    const menu = await screen.findByRole("menu", { name: "Project" });

    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["Acme ACME", "Saga SAGA", "DUNENo folder"]);
    expect(items[2]!.getAttribute("aria-disabled")).toBe("true");
    expect(menu.className).toContain("max-h-(--available-height)");
  });

  it("names a project with no folder by its name when it has one", async () => {
    const replies = { "/projects": successReply([{ tag: "NOTE", name: "Notes" }]) };
    const { user } = await open("/?new=1", startDaemon(replies));

    await user.click(trigger());
    const menu = await screen.findByRole("menu", { name: "Project" });

    expect(within(menu).getByRole("menuitemradio").textContent).toBe("NotesNo folder");
  });

  it("holds one disabled item with no projects", async () => {
    const { user } = await open("/?new=1", startDaemon({ "/projects": successReply([]) }));

    await user.click(trigger());
    const menu = await screen.findByRole("menu", { name: "Project" });

    const item = within(menu).getByRole("menuitem");
    expect(item.textContent).toBe("No projects yet. Add one on the Projects screen.");
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("selects the pick, closes the menu and gives the focus back to the trigger", async () => {
    const { user } = await open("/?new=1");

    await user.click(trigger());
    await user.click(await screen.findByRole("menuitemradio", { name: "Saga SAGA" }));

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger("Project Saga SAGA"));
  });

  it.each([
    ["leaves the list", "deleted", [PROJECTS[0]!]],
    ["loses its folder", "changed", [PROJECTS[0]!, { tag: "SAGA", name: "Saga" }]],
  ] as const)("selects nothing when the project %s while the view is open", async (_name, change, projects) => {
    useUiStore.setState({ lastChatProject: "SAGA" });
    const { user, stub } = await open("/?new=1");
    await user.type(field(), "Plan");
    stub.replies["/projects"] = successReply(projects);

    await stub.send([{ kind: "project", tag: "SAGA", change }]);

    await waitFor(() => {
      expect(within(trigger()).getByText("Select a project")).toBeTruthy();
    });
    expect(sendButton().disabled).toBe(true);
    await user.type(field(), "{Enter}");
    await frame();
    expect(words("Select a project to send the message.")).toHaveLength(1);
    expect(posts(stub)).toEqual([]);
  });

  it("does not store the picked project before a start succeeds", async () => {
    useUiStore.setState({ lastChatProject: "ACME" });
    const { user } = await open("/?new=1");

    await user.click(trigger());
    await user.click(await screen.findByRole("menuitemradio", { name: "Saga SAGA" }));

    expect(useUiStore.getState().lastChatProject).toBe("ACME");
  });
});

describe("the wait", () => {
  async function waiting() {
    const { reply, answer } = heldBack();
    const opened = await open(WITH_PROJECT, startDaemon({ [START_POST]: reply }));

    await opened.user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(screen.getByText("Plan the release")).toBeTruthy();
    });
    return { ...opened, answer };
  }

  it("shows the message, the composer at the bottom and no Send and no Stop", async () => {
    await waiting();

    expect(screen.getByRole("log").textContent).toContain("Plan the release");
    expect(screen.getByRole("log").querySelector('[data-role="assistant"]')).not.toBeNull();
    expect(isDocked()).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Stop generating|Cancel sending/ })).toBeNull();
    expect(field().placeholder).toBe("Queue another message");
  });

  it("adds a line on Enter and sends nothing", async () => {
    const { user, stub } = await waiting();

    await user.type(field(), "More{Enter}text");

    expect(field().value).toBe("More\ntext");
    expect(posts(stub)).toHaveLength(1);
  });

  it("shows the project of the start in a Project trigger that does not open", async () => {
    const { user } = await waiting();

    const shown = trigger("Project Saga SAGA");
    expect(shown.getAttribute("aria-disabled")).toBe("true");
    await user.click(shown);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says the start", async () => {
    await waiting();
    await frame();

    expect(words("Starting a chat in SAGA")).toHaveLength(1);
  });
});

describe("a start that succeeds", () => {
  it("opens the chat as the selected row, with the focus in its message field", async () => {
    const stub = startDaemon();
    const { user, router } = await open(WITH_PROJECT, stub);
    stub.replies["/chats?project=SAGA"] = pageReply([NEW_ROW]);

    await user.type(field(), "Plan the release{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: /^SAGA/ }));
    });
    expect(router.state.location.search).toEqual({ project: "SAGA", tag: "SAGA", chat: "5" });
    expect(itemLink("SAGA", 5).getAttribute("aria-current")).toBe("page");

    await answerLog(stub);
    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
    await frame();

    expect(words(STARTED)).toHaveLength(1);
    expect(useUiStore.getState().startedChat).toBeNull();
    expect(useUiStore.getState().lastChatProject).toBe("SAGA");
  });

  it("gives the focus to the message field also when StrictMode runs the effects of the chat again", async () => {
    const stub = startDaemon();
    const { user } = await open(WITH_PROJECT, stub, true);

    await user.type(field(), "Plan the release{Enter}");
    await screen.findByRole("heading", { level: 2, name: /^SAGA/ });
    await answerLog(stub);

    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
    await frame();
    expect(words(STARTED)).toHaveLength(1);
  });

  it("leaves the focus in the message field when the composer shows before the navigation ends", async () => {
    const replies = { [projectChatPath(5)]: successReply(projectChatRecord({ ...START_RECORD, seq: 0 })) };
    const stub = startDaemon(replies);
    const { user } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    await screen.findByRole("heading", { level: 2, name: /^SAGA/ });

    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
    await frame();
    expect(words(STARTED)).toHaveLength(1);
  });

  it("moves the text typed during the wait to the field of the new chat", async () => {
    const { reply, answer } = heldBack();
    const stub = startDaemon({ [START_POST]: reply });
    const { user } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    await user.type(field(), "One more thing");
    await act(async () => {
      answer(START_ANSWER);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: /^SAGA/ })).toBeTruthy();
    });
    await answerLog(stub);

    await waitFor(() => {
      expect(field().value).toBe("One more thing");
    });
    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("");
  });

  it("says the count of the new filter before the words when the chat takes the focus", async () => {
    const stub = startDaemon();
    const { user } = await open("/?new=1&project=ACME", stub);

    await user.click(trigger());
    await user.click(await screen.findByRole("menuitemradio", { name: "Saga SAGA" }));
    stub.replies["/chats"] = LISTED;
    await user.type(field(), "Plan the release{Enter}");
    await screen.findByRole("heading", { level: 2, name: /^SAGA/ });
    await frame();
    await answerLog(stub);
    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
    await frame();

    const line = `${STARTED} The project filter was cleared.`;
    expect(spoken().indexOf("2 chats")).toBeGreaterThanOrEqual(0);
    expect(spoken().indexOf(line)).toBeGreaterThan(spoken().indexOf("2 chats"));
    expect(words(line)).toHaveLength(1);
  });

  it("says the words before the count of the new filter when the focus left the view", async () => {
    const { reply, answer } = heldBack();
    const stub = startDaemon({ [START_POST]: reply });
    const { user, router } = await open("/?new=1&project=ACME", stub);

    await user.click(trigger());
    await user.click(await screen.findByRole("menuitemradio", { name: "Saga SAGA" }));
    stub.replies["/chats"] = LISTED;
    await user.type(field(), "Plan the release{Enter}");
    const search = screen.getByRole("searchbox");
    search.focus();
    await act(async () => {
      answer(START_ANSWER);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: "SAGA", chat: "5" });
    });
    await frame();

    const line = `${STARTED} The project filter was cleared.`;
    expect(spoken().indexOf(line)).toBeGreaterThanOrEqual(0);
    expect(spoken().indexOf("2 chats")).toBeGreaterThan(spoken().indexOf(line));
    expect(words(line)).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  it("keeps the focus and says the words when the user moves the focus off the heading before the composer shows", async () => {
    const stub = startDaemon();
    const { user, router } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: /^SAGA/ }));
    });
    expect(router.state.location.search).toMatchObject({ tag: "SAGA", chat: "5" });
    const search = screen.getByRole("searchbox");
    search.focus();
    await answerLog(stub);
    await findField();
    await frame();

    expect(document.activeElement).toBe(search);
    expect(words(STARTED)).toHaveLength(1);
  });

  it("moves the focus from the body to the message field when the composer shows", async () => {
    const stub = startDaemon();
    const { user } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: /^SAGA/ }));
    });
    (document.activeElement as HTMLElement).blur();
    await answerLog(stub);

    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
  });

  it("says the words one time when the composer shows after the focus left the view", async () => {
    const { reply, answer } = heldBack();
    const stub = startDaemon({ [START_POST]: reply });
    const { user, router } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    const search = screen.getByRole("searchbox");
    search.focus();
    await act(async () => {
      answer(START_ANSWER);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ tag: "SAGA", chat: "5" });
    });
    await frame();
    await waitFor(() => {
      expect(spoken()).toContain(STARTED);
    });
    await answerLog(stub);
    await findField();
    await frame();

    expect(words(STARTED)).toHaveLength(1);
    expect(document.activeElement).toBe(search);
    expect(useUiStore.getState().startedChat).toBeNull();
  });

  it("says the words one time when the user leaves the chat before they are said", async () => {
    const stub = startDaemon();
    const { user, router } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ tag: "SAGA", chat: "5" });
    });
    await act(async () => {
      await router.navigate({ to: "/", search: { project: "SAGA" } });
    });
    await frame();

    expect(words(STARTED)).toHaveLength(1);
    expect(useUiStore.getState().startedChat).toBeNull();
  });

  it("says the words on the next screen when the user leaves the Dashboard", async () => {
    const stub = startDaemon();
    const { user, router } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ tag: "SAGA", chat: "5" });
    });
    await act(async () => {
      await router.navigate({ to: "/settings" });
    });
    await frame();

    expect(words(STARTED)).toHaveLength(1);
    expect(useUiStore.getState().arrivalWords).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("opens nothing after the user left the view, and keeps the draft", async () => {
    const { reply, answer } = heldBack();
    const stub = startDaemon({ [START_POST]: reply });
    const { user, router } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");
    await user.type(field(), "One more thing");
    await act(async () => {
      await router.navigate({ to: "/settings" });
    });
    await act(async () => {
      answer(START_ANSWER);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await frame();

    expect(router.state.location.pathname).toBe("/settings");
    expect(words(STARTED)).toHaveLength(1);
    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("One more thing");
  });
});

describe("a refused start", () => {
  const REFUSED = refusalReply(409, { kind: "daemon", code: "project-has-no-folder", message: "SAGA has no folder" });

  it("puts the text back in the center, keeps the focus and opens the notice, and a second Send works", async () => {
    const stub = startDaemon({ [START_POST]: REFUSED });
    const { user } = await open(WITH_PROJECT, stub);

    await user.type(field(), "Plan the release{Enter}");

    await waitFor(() => {
      expect(field().value).toBe("Plan the release");
    });
    expect(isDocked()).toBe(false);
    expect(screen.queryByRole("log")?.textContent).toBeFalsy();
    expect(document.activeElement).toBe(field());
    expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["The new chat of SAGA did not start"]);

    stub.replies[START_POST] = START_ANSWER;
    await user.type(field(), "{Enter}");

    await waitFor(() => {
      expect(posts(stub)).toHaveLength(2);
    });
    expect(useNoticeStore.getState().notices).toEqual([]);
  });
});

describe("the Mode and Model pickers", () => {
  const OPTIONS_PATH = "/agents/claude/options";

  const MODE = {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "auto",
    options: [
      { value: "default", name: "Manual" },
      { value: "acceptEdits", name: "Accept edits" },
      { value: "plan", name: "Plan" },
      { value: "auto", name: "Auto" },
      { value: "bypassPermissions", name: "Bypass permissions" },
    ],
  };

  const MODEL = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "small",
    options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }],
  };

  /** The model list after a change that drops Large. */
  const NO_LARGE = { ...MODEL, options: [{ value: "small", name: "Small" }, { value: "medium", name: "Medium" }] };

  const CHANGED = { kind: "agent-options", agent: "claude" } as const;

  const REFUSED = refusalReply(409, { kind: "daemon", code: "project-has-no-folder", message: "SAGA has no folder" });

  function listReply(options: readonly object[] = [MODEL, MODE]) {
    return successReply({ agent: "claude", options, updated: "2026-01-01T00:00:00.000Z" });
  }

  function region(): HTMLElement {
    return screen.getByRole("region", { name: "New chat" });
  }

  function findTrigger(name: RegExp | string): Promise<HTMLElement> {
    return within(region()).findByRole("button", { name });
  }

  function noOptionTriggers(): boolean {
    return within(region()).queryByRole("button", { name: /^(Mode|Model) / }) === null;
  }

  async function pickValue(user: ReturnType<typeof userEvent.setup>, name: RegExp | string, value: string) {
    await user.click(trigger(name));
    await user.click(await screen.findByRole("menuitemradio", { name: value }));
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  }

  async function withList(path = WITH_PROJECT, replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
    const opened = await open(path, startDaemon({ [OPTIONS_PATH]: listReply(), ...replies }));
    await findTrigger("Model Small");
    return opened;
  }

  async function changeList(stub: DashboardStub, reply: TransportReply): Promise<void> {
    const reads = stub.readsOf(OPTIONS_PATH);
    stub.replies[OPTIONS_PATH] = reply;
    await stub.send([CHANGED]);
    await waitFor(() => {
      expect(stub.readsOf(OPTIONS_PATH)).toBe(reads + 1);
    });
  }

  async function settled(stub: DashboardStub): Promise<void> {
    await waitFor(() => {
      expect(stub.paths).toContain(OPTIONS_PATH);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  function startBody(stub: DashboardStub): unknown {
    return posts(stub).find(({ path }) => path === "/projects/SAGA/chats")?.body;
  }

  async function waiting(user: ReturnType<typeof userEvent.setup>) {
    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(screen.getByText("Plan the release")).toBeTruthy();
    });
  }

  async function mountAgain(router: Awaited<ReturnType<typeof open>>["router"]) {
    await act(async () => {
      await router.navigate({ to: "/settings" });
    });
    await act(async () => {
      await router.navigate({ to: "/", search: { new: "1", project: "SAGA" } });
    });
  }

  async function refuse(answer: (reply: TransportReply) => void) {
    await act(async () => {
      answer(REFUSED);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(field().value).toBe("Plan the release");
    });
  }

  it("shows Project, Mode and Model in this order, each with its start value, and offers no Plan", async () => {
    const { user } = await withList();

    const project = trigger(/^Project/);
    const mode = trigger("Mode Auto");
    const model = trigger("Model Small");
    expect(project.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mode.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(mode);
    const menu = await screen.findByRole("menu", { name: "Mode" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["Manual", "Accept edits", "Auto", "Bypass permissions"]);
  });

  it.each([
    ["an empty list", listReply([])],
    ["a first read that fails", refusalReply(500, { kind: "daemon", code: "internal", message: "the disk is full" })],
  ])("shows Project alone with %s, and a start works", async (_case, reply) => {
    const { user, stub } = await open(WITH_PROJECT, startDaemon({ [OPTIONS_PATH]: reply }));
    await settled(stub);

    expect(noOptionTriggers()).toBe(true);
    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(startBody(stub)).toEqual({ text: "Plan the release", client: CHAT_CLIENT });
    });
  });

  it("shows Project alone while no read has given a list", async () => {
    const { reply } = heldBack();
    const { stub } = await open(WITH_PROJECT, startDaemon({ [OPTIONS_PATH]: reply }));
    await settled(stub);

    expect(noOptionTriggers()).toBe(true);
  });

  it("keeps the list and the picks when a later read fails", async () => {
    const { user, stub } = await withList();
    await pickValue(user, /^Model /, "Large");

    await changeList(stub, refusalReply(500, { kind: "daemon", code: "internal", message: "the disk is full" }));
    await settled(stub);

    expect(trigger("Model Large")).toBeTruthy();
    expect(trigger("Mode Auto")).toBeTruthy();
  });

  it("shows a pick in the trigger and sends only the changed values", async () => {
    const { user, stub } = await withList();

    await pickValue(user, /^Model /, "Large");
    expect(document.activeElement).toBe(trigger("Model Large"));
    await user.type(field(), "Plan the release{Enter}");

    await waitFor(() => {
      expect(startBody(stub)).toEqual({ text: "Plan the release", client: CHAT_CLIENT, options: { model: "large" } });
    });
  });

  it("sends no options after a pick of the start value", async () => {
    const { user, stub } = await withList();

    await pickValue(user, /^Model /, "Large");
    await pickValue(user, /^Model /, "Small");
    await user.type(field(), "Plan the release{Enter}");

    await waitFor(() => {
      expect(startBody(stub)).toEqual({ text: "Plan the release", client: CHAT_CLIENT });
    });
    expect(startBody(stub)).not.toHaveProperty("options");
  });

  it("keeps a pick after a change of the project", async () => {
    const { user, stub } = await withList("/?new=1&project=ACME");

    await pickValue(user, /^Mode /, "Accept edits");
    await pickValue(user, /^Project/, "Saga SAGA");
    expect(trigger("Mode Accept edits")).toBeTruthy();
    await user.type(field(), "Plan the release{Enter}");

    await waitFor(() => {
      expect(startBody(stub)).toEqual({ text: "Plan the release", client: CHAT_CLIENT, options: { mode: "acceptEdits" } });
    });
  });

  it("keeps an offered pick at a change of the list, drops another and says the dropped pick one time", async () => {
    const { user, stub } = await withList();
    await pickValue(user, /^Model /, "Large");
    await pickValue(user, /^Mode /, "Accept edits");

    await changeList(stub, listReply([NO_LARGE, MODE]));
    await findTrigger("Model Small");
    await frame();

    expect(trigger("Mode Accept edits")).toBeTruthy();
    expect(words("Large is not offered anymore. Model: Small.")).toHaveLength(1);
    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(startBody(stub)).toEqual({ text: "Plan the release", client: CHAT_CLIENT, options: { mode: "acceptEdits" } });
    });
  });

  it("says a dropped pick one time also when the composer docks for the wait after it", async () => {
    const { reply } = heldBack();
    const { user, stub } = await withList(WITH_PROJECT, { [START_POST]: reply });
    await pickValue(user, /^Model /, "Large");
    await changeList(stub, listReply([NO_LARGE, MODE]));
    await findTrigger("Model Small");
    await frame();

    await user.type(field(), "Plan the release{Enter}");
    await waitFor(() => {
      expect(isDocked()).toBe(true);
    });
    await frame();

    expect(words("Large is not offered anymore. Model: Small.")).toHaveLength(1);
  });

  it("moves the focus to the heading before it says a dropped pick whose picker had the focus", async () => {
    const line = "Model is not offered anymore.";
    const { user, stub } = await withList();
    await pickValue(user, /^Model /, "Large");
    expect(document.activeElement).toBe(trigger("Model Large"));
    const focusAtWords: (Element | null)[] = [];
    const unsubscribe = useNoticeStore.subscribe(({ announced }) => {
      if (focusAtWords.length === 0 && announced.some((one) => one.words === line)) {
        focusAtWords.push(document.activeElement);
      }
    });

    await changeList(stub, listReply([MODE]));
    await waitFor(() => {
      expect(noOptionTriggers()).toBe(false);
      expect(within(region()).queryByRole("button", { name: /^Model / })).toBeNull();
    });
    await frame();
    unsubscribe();

    expect(document.activeElement).toBe(viewHeading());
    expect(focusAtWords).toEqual([viewHeading()]);
    expect(words(line)).toHaveLength(1);
  });

  it("keeps the focus in the message field and says the opening one time when the list comes after the view opens", async () => {
    const { reply, answer } = heldBack();
    await open(WITH_PROJECT, startDaemon({ [OPTIONS_PATH]: reply }));
    expect(document.activeElement).toBe(field());

    await act(async () => {
      answer(listReply());
      await Promise.resolve();
    });
    await findTrigger("Model Small");
    await frame();

    expect(document.activeElement).toBe(field());
    expect(words("New chat in SAGA")).toHaveLength(1);
  });

  describe("while the start waits", () => {
    it("shows the values of the start in triggers that do not open, also after the view mounts again", async () => {
      const { reply } = heldBack();
      const { user, router } = await withList(WITH_PROJECT, { [START_POST]: reply });
      await pickValue(user, /^Model /, "Large");

      await waiting(user);

      for (const name of ["Mode Auto", "Model Large"]) {
        expect(trigger(name).getAttribute("aria-disabled")).toBe("true");
        await user.click(trigger(name));
        expect(screen.queryByRole("menu")).toBeNull();
      }
      await mountAgain(router);
      expect((await findTrigger("Model Large")).getAttribute("aria-disabled")).toBe("true");
      expect(trigger("Mode Auto").getAttribute("aria-disabled")).toBe("true");
    });

    it("drops and says nothing at a change of the list", async () => {
      const { reply } = heldBack();
      const { user, stub } = await withList(WITH_PROJECT, { [START_POST]: reply });
      await pickValue(user, /^Model /, "Large");
      await waiting(user);

      await changeList(stub, listReply([NO_LARGE, MODE]));
      await settled(stub);
      await frame();

      // The new list has no name for the value that the start sent.
      expect(trigger("Model large")).toBeTruthy();
      expect(words("Large is not offered anymore. Model: Small.")).toEqual([]);
    });
  });

  describe("a refused start", () => {
    it("keeps the picks, and a second Send sends them again", async () => {
      const { user, stub } = await withList(WITH_PROJECT, { [START_POST]: REFUSED });
      await pickValue(user, /^Model /, "Large");

      await user.type(field(), "Plan the release{Enter}");
      await waitFor(() => {
        expect(field().value).toBe("Plan the release");
      });

      expect(trigger("Model Large").hasAttribute("aria-disabled")).toBe(false);
      stub.replies[START_POST] = START_ANSWER;
      await user.type(field(), "{Enter}");
      await waitFor(() => {
        expect(posts(stub).filter(({ path }) => path === "/projects/SAGA/chats")).toHaveLength(2);
      });
      expect(posts(stub).at(-1)?.body).toEqual({ text: "Plan the release", client: CHAT_CLIENT, options: { model: "large" } });
    });

    it("keeps the picks when the view mounts again during the wait", async () => {
      const { reply, answer } = heldBack();
      const { user, stub, router } = await withList(WITH_PROJECT, { [START_POST]: reply });
      await pickValue(user, /^Model /, "Large");
      await pickValue(user, /^Mode /, "Accept edits");
      await waiting(user);
      await mountAgain(router);
      await findTrigger("Model Large");

      await refuse(answer);

      expect(trigger("Model Large").hasAttribute("aria-disabled")).toBe(false);
      expect(trigger("Mode Accept edits")).toBeTruthy();
      stub.replies[START_POST] = START_ANSWER;
      await user.type(field(), "{Enter}");
      await waitFor(() => {
        expect(posts(stub).filter(({ path }) => path === "/projects/SAGA/chats")).toHaveLength(2);
      });
      expect(posts(stub).at(-1)?.body).toEqual({
        text: "Plan the release",
        client: CHAT_CLIENT,
        options: { mode: "acceptEdits", model: "large" },
      });
    });

    it("drops and says a pick that the list stopped offering during the wait", async () => {
      const { reply, answer } = heldBack();
      const { user, stub } = await withList(WITH_PROJECT, { [START_POST]: reply });
      await pickValue(user, /^Model /, "Large");
      await waiting(user);
      await changeList(stub, listReply([NO_LARGE, MODE]));
      await settled(stub);

      await refuse(answer);
      await frame();

      expect(trigger("Model Small")).toBeTruthy();
      expect(words("Large is not offered anymore. Model: Small.")).toHaveLength(1);
    });

    it("drops and says that pick also when the view mounts again after the change of the list", async () => {
      const { reply, answer } = heldBack();
      const { user, stub, router } = await withList(WITH_PROJECT, { [START_POST]: reply });
      await pickValue(user, /^Model /, "Large");
      await pickValue(user, /^Mode /, "Accept edits");
      await waiting(user);
      await changeList(stub, listReply([NO_LARGE, MODE]));
      await settled(stub);
      await mountAgain(router);
      await findTrigger("Model large");

      await refuse(answer);
      await frame();

      expect(trigger("Model Small")).toBeTruthy();
      expect(trigger("Mode Accept edits")).toBeTruthy();
      // The view that mounts again names the value by the list of that time, which has no name for it.
      expect(words("large is not offered anymore. Model: Small.")).toHaveLength(1);

      await changeList(stub, listReply());
      await settled(stub);
      await frame();
      expect(trigger("Model Small")).toBeTruthy();

      stub.replies[START_POST] = START_ANSWER;
      await user.type(field(), "{Enter}");
      await waitFor(() => {
        expect(posts(stub).filter(({ path }) => path === "/projects/SAGA/chats")).toHaveLength(2);
      });
      expect(posts(stub).at(-1)?.body).toEqual({ text: "Plan the release", client: CHAT_CLIENT, options: { mode: "acceptEdits" } });
    });
  });
});

describe("a narrow window", () => {
  it("replaces the list with the view, and Chats gives the focus to New chat with the draft kept", async () => {
    stubWindowWidth("narrow");
    const { user } = await open("/?new=1");

    expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
    await user.type(field(), "Plan the release");
    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Chats" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(newChatButton());
    });
    expect(screen.queryByRole("textbox", { name: "Message input" })).toBeNull();
    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("Plan the release");
  });

  it("opens the view from New chat with the focus in the field", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    await renderDashboard(startDaemon());

    await user.click(newChatButton());

    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
    expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
  });
});
