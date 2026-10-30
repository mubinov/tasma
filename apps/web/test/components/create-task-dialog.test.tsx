import { QueryClientProvider } from "@tanstack/react-query";
import { createClient, type Diagnostic, type TaskEntry, type TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import type { Created } from "../../src/api/mutations";
import { FIELD_TRIGGER_CLASS } from "../../src/components/control-classes";
import { CreateTaskDialog, type CreateProject } from "../../src/components/create-task-dialog";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { CONFIG, DELTA, entry, listing, OTHER_CONFIG, SAGA, taggedEntry } from "../board-fixtures";
import { heldBack, refusalReply, stubTransport, successReply } from "../helpers";
import { frame } from "../setup/notice-store";

const CREATE = "POST /projects/SAGA/tasks";

const CREATE_DELTA = "POST /projects/DELTA/tasks";

const ENTRIES = [entry(1, { labels: ["web"] }), entry(2, { labels: ["ops", "web"] })];

const CREATED = successReply({ id: "SAGA-7", status: "To Do" });

/** A second project whose priorities differ from those of `CONFIG`. */
const DELTA_CONFIG = { ...OTHER_CONFIG, priorities: ["urgent", "high"] };

const DELTA_ENTRIES = [taggedEntry("DELTA", 1, { labels: ["cellar"] })];

type SetupOptions = {
  /** The tasks of SAGA. */
  entries?: readonly TaskEntry[];
  /** Gives the dialog DELTA and SAGA, with the Project field. */
  several?: boolean;
  /** DELTA declares no name. */
  unnamed?: boolean;
  /** The `byTag` of the column whose plus is pressed. */
  plusColumn?: Readonly<Record<string, string>>;
};

/**
 * Mounts the board's part: the two controls that open the dialog, and the state
 * that holds it open. The dialog opens on SAGA. `removePlus` takes the column's
 * plus off the page while the dialog is open, `removeOpeners` takes both
 * controls off, and `leave` takes a project off the board.
 */
function setup(
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
  { entries = ENTRIES, several = false, unnamed = false, plusColumn = { SAGA: "To Do" } }: SetupOptions = {},
) {
  const stub = stubTransport({
    "/projects/SAGA/tasks": listing([...entries]),
    "/projects/DELTA/tasks": listing([...DELTA_ENTRIES]),
    [CREATE]: CREATED,
    [CREATE_DELTA]: successReply({ id: "DELTA-4", status: "To Do" }),
    ...replies,
  });
  const client = createClient(stub.transport);
  const queryClient = createAppQueryClient();
  const created: Created[] = [];
  // The tags the board shows as each receipt reaches it.
  const createdOn: string[][] = [];
  const saga: CreateProject = { ...SAGA, config: CONFIG, entries };
  const delta: CreateProject = {
    ...(unnamed ? { tag: DELTA.tag } : DELTA),
    config: DELTA_CONFIG,
    entries: DELTA_ENTRIES,
  };
  const projects = several ? [delta, saga] : [saga];

  type BoardProps = { openers: "both" | "new task" | "none"; shown: readonly CreateProject[] };

  function Board({ openers, shown }: BoardProps): ReactNode {
    const [creating, setCreating] = useState<{
      column: Readonly<Record<string, string>> | null;
      opener: HTMLElement;
    } | null>(null);
    const newTaskRef = useRef<HTMLButtonElement>(null);
    const mainRef = useRef<HTMLElement>(null);
    const [fallbacks, setFallbacks] = useState(0);

    useEffect(() => {
      if (fallbacks > 0) {
        mainRef.current?.focus();
      }
    }, [fallbacks]);

    return (
      <QueryClientProvider client={queryClient}>
        <main ref={mainRef} tabIndex={-1}>
          <a href="#search">Search</a>
          {openers !== "none" && (
            <button
              ref={newTaskRef}
              type="button"
              onClick={(event) => {
                setCreating({ column: null, opener: event.currentTarget });
              }}
            >
              New task
            </button>
          )}
          {openers === "both" && (
            <button
              type="button"
              onClick={(event) => {
                setCreating({ column: plusColumn, opener: event.currentTarget });
              }}
            >
              New task in To Do
            </button>
          )}
        </main>
        {creating !== null && (
          <CreateTaskDialog
            queryClient={queryClient}
            client={client}
            projects={shown}
            startTag="SAGA"
            column={creating.column}
            chooseProject={several}
            opener={creating.opener}
            newTaskRef={newTaskRef}
            focusFallback={() => {
              setFallbacks((count) => count + 1);
            }}
            onClose={() => {
              setCreating(null);
            }}
            onCreated={(result) => {
              created.push(result);
              createdOn.push(shown.map(({ tag }) => tag));
              setCreating(null);
            }}
          />
        )}
      </QueryClientProvider>
    );
  }

  const rendered = render(<Board openers="both" shown={projects} />);

  return {
    ...stub,
    created,
    createdOn,
    removePlus: () => {
      rendered.rerender(<Board openers="new task" shown={projects} />);
    },
    removeOpeners: () => {
      rendered.rerender(<Board openers="none" shown={projects} />);
    },
    leave: (tag: string) => {
      rendered.rerender(<Board openers="both" shown={projects.filter((project) => project.tag !== tag)} />);
    },
  };
}

/** Opens the dialog from the column's plus, on "To Do", and waits for focus to land in Title. */
async function openFromPlus(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New task in To Do" }));
  await waitFor(() => {
    expect(document.activeElement).toBe(titleInput());
  });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "New task" });
}

function titleInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Title" });
}

function bodyInput(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Body" });
}

function control(name: string | RegExp): HTMLElement {
  return within(dialog()).getByRole("button", { name });
}

function labelsTrigger(): HTMLElement {
  return screen.getByRole("combobox", { name: /^Labels/ });
}

function creates(requests: readonly { method: string }[]): unknown[] {
  return requests.filter(({ method }) => method === "POST");
}

function announced(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

/** The element's description as a screen reader reads it, with the marks it is not given left out. */
function described(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => {
      const part = document.getElementById(id)?.cloneNode(true) as Element | null;
      for (const hidden of part?.querySelectorAll("[aria-hidden]") ?? []) {
        hidden.remove();
      }

      return part?.textContent ?? `missing ${id}`;
    })
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** The viewport over the scrim, where a press is a press outside the panel. */
function viewport(): HTMLElement {
  return dialog().parentElement!;
}

async function pick(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, item: string) {
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  await user.click(within(menu).getByRole("menuitemradio", { name: item }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

afterEach(() => {
  cleanup();
});

describe("the dialog", () => {
  it("is named New task, starts in Title, and names each row", async () => {
    const user = userEvent.setup();
    setup();

    await openFromPlus(user);

    expect(dialog()).toBeTruthy();
    expect(titleInput().getAttribute("placeholder")).toBe("Required");
    expect(titleInput().getAttribute("aria-required")).toBe("true");
    expect(titleInput().hasAttribute("required")).toBe(false);
    expect(control("Status To Do")).toBeTruthy();
    expect(control("Priority None")).toBeTruthy();
    expect(labelsTrigger().textContent).toBe("None");
    expect(screen.getByRole("combobox", { name: "Labels None" })).toBe(labelsTrigger());
    expect(bodyInput().getAttribute("placeholder")).toBe("Write in markdown");
    expect(described(bodyInput())).toBe("Markdown Command Enter create Escape cancel");
    expect(within(dialog()).getAllByRole("button").map((button) => button.textContent).slice(-2)).toEqual([
      "Cancel",
      "Create",
    ]);
  });

  it("marks focus on Title by its border, never by a ring", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);

    expect([...titleInput().classList]).toEqual(
      expect.arrayContaining(["focus-visible:outline-hidden", "not-data-invalid:focus:border-focus"]),
    );
  });

  // jsdom lacks Chrome's `aria-hidden` rule, so the mechanism is pinned: focus is on nothing before any await.
  it("leaves no element outside the panel focused in the commit that opens it", () => {
    setup();
    const opener = screen.getByRole("button", { name: "New task in To Do" });
    opener.focus();

    fireEvent.click(opener);

    expect(dialog()).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("opens on the status it is given", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "New task" }));

    expect(control("Status Backlog")).toBeTruthy();
  });

  it("shows each menu trigger in the field style, with its value and a caret", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);

    for (const trigger of [control("Status To Do"), control("Priority None"), labelsTrigger()]) {
      expect(trigger.className).toBe(FIELD_TRIGGER_CLASS);
      expect(trigger.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    }
    expect(control("Priority None").querySelector(".text-dim")?.textContent).toBe("None");
  });

  it("changes a trigger on a pick of Status, Priority or Labels, and sends nothing", async () => {
    const user = userEvent.setup();
    const { requests } = setup();
    await openFromPlus(user);

    await pick(user, control("Status To Do"), "Done");
    await pick(user, control("Priority None"), "high");
    await user.click(labelsTrigger());
    await user.click(await screen.findByRole("option", { name: /^ops/ }));
    await user.keyboard("{Escape}");

    expect(control("Status Done")).toBeTruthy();
    expect(control("Priority high")).toBeTruthy();
    expect(labelsTrigger().textContent).toBe("ops");
    expect(creates(requests)).toEqual([]);
  });

  it("offers the labels of every task it is given, with their counts", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);

    await user.click(labelsTrigger());

    const names = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(names).toEqual(["ops1", "web2"]);
  });
});

describe("the Project field", () => {
  const REFUSAL = refusalReply(422, { kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" });

  async function openNewTask(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "New task" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput());
    });
  }

  function projectTrigger(): HTMLElement {
    return control(/^Project /);
  }

  /** The items of the menu of `trigger`, which is closed again. */
  async function menuItems(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement): Promise<string[]> {
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    const names = within(menu).getAllByRole("menuitemradio").map((item) => item.textContent);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });

    return names;
  }

  it("is absent on a board of one project, and the dialog has no description", async () => {
    const user = userEvent.setup();
    setup();

    await openNewTask(user);

    expect(within(dialog()).queryByRole("button", { name: /^Project/ })).toBeNull();
    expect(within(dialog()).queryByText("Project")).toBeNull();
    expect(dialog().hasAttribute("aria-describedby")).toBe(false);
  });

  it("is the first row, named Project, shows the start project, and leaves the first focus in Title", async () => {
    const user = userEvent.setup();
    setup({}, { several: true });

    await openNewTask(user);

    const grid = titleInput().closest("form")!.firstElementChild!;
    expect(grid.firstElementChild?.textContent).toBe("Project");
    expect(grid.children[1]).toBe(control("Project Saga SAGA"));
    expect(projectTrigger().className).toBe(FIELD_TRIGGER_CLASS);
    expect(projectTrigger().lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(document.activeElement).toBe(titleInput());
    expect(described(dialog())).toBe("The task is created in Saga SAGA, with the status Backlog.");
  });

  it("offers the projects it is given, in their order, the selected one checked, in a list that scrolls", async () => {
    const user = userEvent.setup();
    setup({}, { several: true });
    await openNewTask(user);

    await user.click(projectTrigger());

    const menu = await screen.findByRole("menu", { name: "Project" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Delta DELTA",
      "Saga SAGA",
    ]);
    expect(within(menu).getByRole("menuitemradio", { checked: true }).textContent).toBe("Saga SAGA");
    expect([...menu.classList]).toEqual(expect.arrayContaining(["max-h-(--available-height)", "overflow-y-auto"]));
  });

  it("gives the statuses, the priorities and the labels of the picked project, describes it, and creates in it", async () => {
    const user = userEvent.setup();
    const { requests, created } = setup({}, { several: true });
    await openNewTask(user);
    await user.keyboard("Map");

    await pick(user, projectTrigger(), "Delta DELTA");

    expect(projectTrigger()).toBe(control("Project Delta DELTA"));
    expect(described(dialog())).toBe("The task is created in Delta DELTA, with the status To Do.");
    expect(await menuItems(user, control("Status To Do"))).toEqual(["To Do", "Review", "Done"]);
    expect(await menuItems(user, control("Priority None"))).toEqual(["urgent", "high", "None"]);
    await user.click(labelsTrigger());
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["cellar1"]);
    await user.keyboard("{Escape}");

    await user.click(control("Create"));

    await waitFor(() => {
      expect(created).toEqual([{ id: "DELTA-4", status: "To Do", diagnostics: [] }]);
    });
    expect(creates(requests)).toEqual([
      { method: "POST", path: "/projects/DELTA/tasks", body: { title: "Map", status: "To Do" } },
    ]);
  });

  it("creates in the project picked in the open menu by the ⌘↩ of the same key press", async () => {
    const user = userEvent.setup();
    const { requests, created } = setup({}, { several: true });
    await openNewTask(user);
    await user.keyboard("Map");
    await user.click(projectTrigger());
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Delta DELTA");
    });

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(creates(requests)).toEqual([
      { method: "POST", path: "/projects/DELTA/tasks", body: { title: "Map", status: "To Do" } },
    ]);
  });

  it("keeps the labels of the draft", async () => {
    const user = userEvent.setup();
    setup({}, { several: true });
    await openNewTask(user);
    await user.click(labelsTrigger());
    await user.click(await screen.findByRole("option", { name: /^web/ }));
    await user.keyboard("{Escape}");

    await pick(user, projectTrigger(), "Delta DELTA");

    expect(labelsTrigger().textContent).toBe("web");
  });

  it("gives the status of the plus's column in the picked project, and the default status where it has none", async () => {
    const user = userEvent.setup();
    setup({}, { several: true, plusColumn: { DELTA: "Review" } });

    await openFromPlus(user);

    expect(control("Status Backlog")).toBeTruthy();
    expect(described(dialog())).toBe("The task is created in Saga SAGA, with the status Backlog.");

    await pick(user, projectTrigger(), "Delta DELTA");

    expect(control("Status Review")).toBeTruthy();
  });

  it("keeps a status picked by hand in a project that has it", async () => {
    const user = userEvent.setup();
    setup({}, { several: true });
    await openNewTask(user);
    await pick(user, control("Status Backlog"), "Done");

    await pick(user, projectTrigger(), "Delta DELTA");

    expect(control("Status Done")).toBeTruthy();
  });

  it("gives a status picked by hand back when the project of the pick is selected again", async () => {
    const user = userEvent.setup();
    setup({}, { several: true });
    await openNewTask(user);
    await pick(user, control("Status Backlog"), "In Progress");

    await pick(user, projectTrigger(), "Delta DELTA");
    expect(control("Status To Do")).toBeTruthy();

    await pick(user, projectTrigger(), "Saga SAGA");
    expect(control("Status In Progress")).toBeTruthy();
  });

  it("gives no priority for a picked priority the project lacks, and says what changed once focus is back", async () => {
    const user = userEvent.setup();
    setup({}, { several: true });
    await openNewTask(user);
    await pick(user, control("Priority None"), "medium");
    await frame();
    const focusAtWords: (Element | null)[] = [];
    const stop = useNoticeStore.subscribe((state, before) => {
      if (state.announced !== before.announced) {
        focusAtWords.push(document.activeElement);
      }
    });

    await pick(user, projectTrigger(), "Delta DELTA");
    await frame();
    stop();

    expect(control("Priority None")).toBeTruthy();
    expect(announced()).toEqual(["Status is now To Do. Priority is now None."]);
    expect(focusAtWords).toEqual([projectTrigger()]);
  });

  it("keeps a picked priority the project has, and says only the status that changed", async () => {
    const user = userEvent.setup();
    setup({}, { several: true });
    await openNewTask(user);
    await pick(user, control("Priority None"), "high");

    await pick(user, projectTrigger(), "Delta DELTA");
    await frame();

    expect(control("Priority high")).toBeTruthy();
    expect(announced()).toEqual(["Status is now To Do."]);
  });

  it("says nothing for a pick that changes neither Status nor Priority, and asks Discard your changes? on Esc", async () => {
    const user = userEvent.setup();
    setup({}, { several: true, plusColumn: { DELTA: "To Do", SAGA: "To Do" } });
    await openFromPlus(user);

    await pick(user, projectTrigger(), "Delta DELTA");
    await frame();

    expect(announced()).toEqual([]);

    await user.keyboard("{Escape}");

    expect(await screen.findByRole("alertdialog", { name: "Discard your changes?" })).toBeTruthy();
  });

  it("takes the refusal and its description away on a pick of another project", async () => {
    const user = userEvent.setup();
    setup({ [CREATE]: REFUSAL }, { several: true });
    await openNewTask(user);
    await user.keyboard("Map{Enter}");
    await waitFor(() => {
      expect(screen.getByText("The task was not created")).toBeTruthy();
    });
    const area = screen.getByText("The task was not created").closest<HTMLElement>("[id]")!;
    expect(described(dialog())).toBe(`The task is created in Saga SAGA, with the status Backlog. ${area.textContent}`);

    await pick(user, projectTrigger(), "Delta DELTA");

    expect(screen.queryByText("The task was not created")).toBeNull();
    expect(described(dialog())).toBe("The task is created in Delta DELTA, with the status To Do.");
  });

  it("does not apply a pick while the create is sent, and says why once the menu has closed", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { requests, created } = setup({ [CREATE]: write.reply }, { several: true });
    await openNewTask(user);
    await user.keyboard("Map{Enter}");
    await waitFor(() => {
      expect(control("Creating…")).toBeTruthy();
    });
    await frame();

    await pick(user, projectTrigger(), "Delta DELTA");
    await frame();

    expect(projectTrigger()).toBe(control("Project Saga SAGA"));
    expect(control("Status Backlog")).toBeTruthy();
    expect(announced()).toEqual(["Creating…", "The task is being created. Its project cannot change now."]);

    await act(async () => {
      write.answer(CREATED);
    });
    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(creates(requests)).toEqual([
      { method: "POST", path: "/projects/SAGA/tasks", body: { title: "Map", status: "Backlog" } },
    ]);
  });

  it("keeps the selected project in the menu, in board order, after it leaves the board, and creates in it", async () => {
    const user = userEvent.setup();
    const { requests, created, leave } = setup({}, { several: true });
    await openNewTask(user);
    await user.keyboard("Map");
    await pick(user, projectTrigger(), "Delta DELTA");

    leave("DELTA");

    expect(projectTrigger()).toBe(control("Project Delta DELTA"));
    expect(await menuItems(user, projectTrigger())).toEqual(["Delta DELTA", "Saga SAGA"]);

    await user.click(control("Create"));

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(creates(requests)).toEqual([
      { method: "POST", path: "/projects/DELTA/tasks", body: { title: "Map", status: "To Do" } },
    ]);
  });

  it("takes a project that is not selected off the menu when it leaves the board", async () => {
    const user = userEvent.setup();
    const { leave } = setup({}, { several: true });
    await openNewTask(user);

    leave("DELTA");

    expect(await menuItems(user, projectTrigger())).toEqual(["Saga SAGA"]);
  });

  it("names a project that declares no name by its tag", async () => {
    const user = userEvent.setup();
    setup({}, { several: true, unnamed: true });
    await openNewTask(user);

    await pick(user, projectTrigger(), "DELTA");

    expect(projectTrigger()).toBe(control("Project DELTA"));
    expect(described(dialog())).toBe("The task is created in DELTA, with the status To Do.");
  });

  it("changes nothing on a pick of the selected project, and keeps the refusal", async () => {
    const user = userEvent.setup();
    setup({ [CREATE]: REFUSAL }, { several: true });
    await openNewTask(user);
    await user.keyboard("Map{Enter}");
    await waitFor(() => {
      expect(screen.getByText("The task was not created")).toBeTruthy();
    });
    await frame();
    const said = announced();

    await pick(user, projectTrigger(), "Saga SAGA");
    await frame();

    expect(screen.getByText("The task was not created")).toBeTruthy();
    expect(control("Status Backlog")).toBeTruthy();
    expect(announced()).toEqual(said);
  });
});

describe("a blank title", () => {
  it("shows the error, focuses Title and sends nothing, speaking the error only to a caret already there", async () => {
    const user = userEvent.setup();
    const { requests } = setup();
    await openFromPlus(user);

    await user.keyboard("{Enter}");
    await frame();

    expect(creates(requests)).toEqual([]);
    expect(titleInput().getAttribute("aria-invalid")).toBe("true");
    expect(described(titleInput())).toBe("A task needs a title.");
    expect(announced()).toEqual(["A task needs a title."]);

    await user.click(bodyInput());
    await user.keyboard("Notes");
    await user.click(control("Create"));
    await frame();

    expect(document.activeElement).toBe(titleInput());
    expect(announced()).toEqual(["A task needs a title."]);
    expect(creates(requests)).toEqual([]);
  });

  it("puts the error under Title alone, with the label level with the input", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);

    await user.keyboard("{Enter}");
    await frame();

    const error = screen.getByText("A task needs a title.");
    const label = screen.getByText("Title");
    expect(error.parentElement).toBe(titleInput().parentElement);
    expect(label.parentElement).not.toBe(titleInput().parentElement);
    expect(label.classList.contains("self-start")).toBe(true);
  });

  it("counts a title of spaces as blank, and clears the error once the title holds text", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);

    await user.keyboard("   {Enter}");
    expect(titleInput().getAttribute("aria-invalid")).toBe("true");

    await user.keyboard("Map");

    expect(titleInput().hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByText("A task needs a title.")).toBeNull();
  });
});

describe("the keys", () => {
  it("creates on Enter in Title, with the draft as the body of the POST", async () => {
    const user = userEvent.setup();
    const { requests, created } = setup();
    await openFromPlus(user);

    await user.keyboard("Draw the map{Enter}");

    await waitFor(() => {
      expect(created).toEqual([{ id: "SAGA-7", status: "To Do", diagnostics: [] }]);
    });
    expect(requests.filter(({ method }) => method === "POST")).toEqual([
      { method: "POST", path: "/projects/SAGA/tasks", body: { title: "Draw the map", status: "To Do" } },
    ]);
  });

  it("adds a line on Enter in Body, and creates on ⌘↩ there", async () => {
    const user = userEvent.setup();
    const { requests, created } = setup();
    await openFromPlus(user);
    await user.keyboard("Map");

    await user.click(bodyInput());
    await user.keyboard("One{Enter}Two");

    expect(bodyInput().value).toBe("One\nTwo");
    expect(creates(requests)).toEqual([]);

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(requests.find(({ method }) => method === "POST")?.body).toEqual({ title: "Map", status: "To Do", body: "One\nTwo" });
  });

  it("creates on Ctrl+↩", async () => {
    const user = userEvent.setup();
    const { created } = setup();
    await openFromPlus(user);

    await user.keyboard("Map{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
  });

  it("sends the label picked in the open picker when ⌘↩ follows there", async () => {
    const user = userEvent.setup();
    const { requests, created } = setup();
    await openFromPlus(user);
    await user.keyboard("Map");
    await user.click(labelsTrigger());
    await user.click(await screen.findByRole("option", { name: /^web/ }));

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(requests.find(({ method }) => method === "POST")?.body).toEqual({ title: "Map", status: "To Do", labels: ["web"] });
  });
});

describe("while the create runs", () => {
  async function pending() {
    const user = userEvent.setup();
    const write = heldBack();
    const context = setup({ [CREATE]: write.reply });
    await openFromPlus(user);
    await user.keyboard("Map{Enter}");
    await waitFor(() => {
      expect(control("Creating…")).toBeTruthy();
    });

    return { ...context, user, write };
  }

  it("reads Creating… on Create, never disabled, and sends a second Create nowhere", async () => {
    const { user, write, requests, created } = await pending();
    await frame();

    await user.click(control("Creating…"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(control("Creating…").hasAttribute("disabled")).toBe(false);
    expect(creates(requests)).toHaveLength(1);
    expect(announced()).toEqual(["Creating…"]);

    await act(async () => {
      write.answer(CREATED);
    });
    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
  });

  it("keeps the dialog open on Cancel, Esc and a press on the scrim, and says why", async () => {
    const { user, write } = await pending();
    await frame();

    await user.click(control("Cancel"));
    await frame();
    await user.keyboard("{Escape}");
    await frame();
    await user.click(viewport());
    await frame();

    expect(dialog()).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(announced()).toEqual([
      "Creating…",
      "The task is being created and cannot be cancelled now.",
      "The task is being created and cannot be cancelled now.",
      "The task is being created and cannot be cancelled now.",
    ]);
    await act(async () => {
      write.answer(CREATED);
    });
  });

  it("says the wait once for a held Esc", async () => {
    const { write } = await pending();
    await frame();

    fireEvent.keyDown(titleInput(), { key: "Escape" });
    await frame();
    fireEvent.keyDown(titleInput(), { key: "Escape", repeat: true });
    await frame();
    fireEvent.keyDown(titleInput(), { key: "Escape", repeat: true });
    await frame();

    expect(announced().filter((words) => words.startsWith("The task is being created"))).toHaveLength(1);
    await act(async () => {
      write.answer(CREATED);
    });
  });

  it("keeps the fields editable, and leaves the write in flight as it was sent", async () => {
    const { user, write, requests, created } = await pending();

    await user.keyboard(" and more");
    await act(async () => {
      write.answer(CREATED);
    });

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(requests.find(({ method }) => method === "POST")?.body).toEqual({ title: "Map", status: "To Do" });
  });

  it("hands the receipt to the board as it stands when the create lands", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { createdOn, leave } = setup({ [CREATE]: write.reply }, { several: true });
    await openFromPlus(user);
    await user.keyboard("Map{Enter}");
    await waitFor(() => {
      expect(control("Creating…")).toBeTruthy();
    });

    leave("DELTA");
    await act(async () => {
      write.answer(CREATED);
    });

    await waitFor(() => {
      expect(createdOn).toEqual([["SAGA"]]);
    });
  });
});

describe("a success", () => {
  it("hands the receipt to the board, closes, and leaves focus where the board puts it", async () => {
    const user = userEvent.setup();
    const found: Diagnostic = { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" };
    const { created } = setup({ [CREATE]: successReply({ id: "SAGA-7", status: "To Do" }, [found]) });
    await openFromPlus(user);

    await user.keyboard("Map{Enter}");

    await waitFor(() => {
      expect(created).toEqual([{ id: "SAGA-7", status: "To Do", diagnostics: [found] }]);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "New task in To Do" }));
    expect(useNoticeStore.getState().notices).toEqual([]);
  });
});

describe("a refusal", () => {
  const REFUSAL = refusalReply(422, { kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" });
  const LINE = "The daemon refused the write, so no task was created. Its own words are below.";
  const WORDS = "store/status-unknown · status \"Gone\" is not configured";

  it("keeps the dialog and every field, shows the refusal above the buttons, and names it in the description", async () => {
    const user = userEvent.setup();
    const { replies, created } = setup({ [CREATE]: REFUSAL });
    await openFromPlus(user);
    await user.keyboard("Map");
    await pick(user, control("Priority None"), "low");
    await user.click(bodyInput());
    await user.keyboard("Notes");

    await user.click(control("Create"));

    await waitFor(() => {
      expect(screen.getByText("The task was not created")).toBeTruthy();
    });
    await frame();
    const area = screen.getByText("The task was not created").closest<HTMLElement>("[id]")!;
    expect(area.textContent).toBe(`The task was not created${LINE}${WORDS}`);
    expect(area.nextElementSibling?.textContent).toBe("CancelCreate");
    expect(described(dialog())).toBe(area.textContent);
    expect(titleInput().value).toBe("Map");
    expect(control("Priority low")).toBeTruthy();
    expect(bodyInput().value).toBe("Notes");
    expect(document.activeElement).toBe(control("Create"));
    expect(announced()).toEqual(["Creating…", `The task was not created. ${LINE} ${WORDS}.`]);
    expect(useNoticeStore.getState().notices).toEqual([]);
    expect(created).toEqual([]);

    replies[CREATE] = heldBack().reply;
    await user.click(control("Create"));

    await waitFor(() => {
      expect(screen.queryByText("The task was not created")).toBeNull();
    });
    expect(dialog().hasAttribute("aria-describedby")).toBe(false);
  });

  it("marks Body for a refusal about the body, adds the correction to the spoken line, and clears it on a change", async () => {
    const user = userEvent.setup();
    const fix = "The body starts a line with a comment marker. Indent that line, or change its first characters.";
    setup({
      [CREATE]: refusalReply(422, { kind: "serialize", code: "marker-collision", message: "the body cannot be written", line: 1 }),
    });
    await openFromPlus(user);
    await user.keyboard("Map");
    await user.click(bodyInput());
    await user.keyboard("<!-- a -->");

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(bodyInput().getAttribute("aria-invalid")).toBe("true");
    });
    await frame();
    expect(described(bodyInput())).toBe(`Markdown Command Enter create Escape cancel ${fix}`);
    expect(announced().at(-1)).toBe(
      "The task was not created. The daemon refused the write, so no task was created. Its own words are below. "
      + `serialize/marker-collision · the body cannot be written. ${fix}`,
    );
    expect(document.activeElement).toBe(bodyInput());

    await user.keyboard("{Backspace}");

    expect(bodyInput().hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("cancel", () => {
  it("closes a dialog with nothing in it at once, and focus goes back to the opener", async () => {
    const user = userEvent.setup();
    const { requests } = setup();
    await openFromPlus(user);

    await user.click(control("Cancel"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New task in To Do" }));
    });
    expect(creates(requests)).toEqual([]);
  });

  it("sends focus to New task when the opener has left the page", async () => {
    const user = userEvent.setup();
    const { removePlus } = setup();
    await openFromPlus(user);
    removePlus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New task" }));
    });
  });

  it("sends focus to the board's last target when neither the opener nor New task is on the page", async () => {
    const user = userEvent.setup();
    const { removeOpeners } = setup();
    await openFromPlus(user);
    removeOpeners();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
  });

  it.each([
    ["Cancel", async (user: ReturnType<typeof userEvent.setup>) => user.click(control("Cancel"))],
    ["Esc", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["a press on the scrim", async (user: ReturnType<typeof userEvent.setup>) => user.click(viewport())],
  ])("asks Discard your changes? on %s once the dialog holds something", async (_way, press) => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);
    await pick(user, control("Status To Do"), "Done");

    await press(user);

    const confirm = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    expect(confirm.textContent).toContain("The new task is not created, and what you wrote is lost. There is no undo.");
    await waitFor(() => {
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep editing" }));
    });
    expect(within(confirm).getByRole("button", { name: "Discard" })).toBeTruthy();
    // Under the confirm, and out of the accessibility tree while it is open.
    expect(screen.getByRole("dialog", { name: "New task", hidden: true })).toBeTruthy();
  });

  it("keeps the dialog and its fields on Esc in the confirm, and focus goes back where it was", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);
    await user.keyboard("Map");

    await user.keyboard("{Escape}");
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(dialog()).toBeTruthy();
    expect(titleInput().value).toBe("Map");
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput());
    });
  });

  it("opens the confirm once for a held Esc, and keeps it open", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);
    await user.keyboard("Map");

    fireEvent.keyDown(titleInput(), { key: "Escape" });
    const confirm = await screen.findByRole("alertdialog");
    await waitFor(() => {
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep editing" }));
    });
    for (let repeat = 0; repeat < 3; repeat++) {
      fireEvent.keyDown(document.activeElement!, { key: "Escape", repeat: true });
      await frame();
    }

    expect(screen.getByRole("alertdialog")).toBe(confirm);
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "New task", hidden: true })).toBeTruthy();
  });

  it("returns focus to Cancel after Keep editing when no control of the dialog held focus", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);
    await user.keyboard("Map");
    act(() => {
      titleInput().blur();
    });

    fireEvent.keyDown(document.body, { key: "Escape" });
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Keep editing" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(control("Cancel"));
    });
  });

  it("closes both dialogs on Discard, creates nothing, and focus goes back to the opener", async () => {
    const user = userEvent.setup();
    const { requests } = setup();
    await openFromPlus(user);
    await user.keyboard("Map");
    await user.click(control("Cancel"));
    const confirm = await screen.findByRole("alertdialog");

    await user.click(within(confirm).getByRole("button", { name: "Discard" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New task in To Do" }));
    });
    expect(creates(requests)).toEqual([]);
  });

  it("counts as a modal dialog while it is open", async () => {
    const user = userEvent.setup();
    setup();
    expect(useUiStore.getState().modalDialogs).toBe(0);

    await openFromPlus(user);
    expect(useUiStore.getState().modalDialogs).toBe(1);

    await user.keyboard("Map");
    await user.click(control("Cancel"));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUiStore.getState().modalDialogs).toBe(0);
  });
});

describe("Esc inside an open popup", () => {
  it("closes an open Status menu alone", async () => {
    const user = userEvent.setup();
    setup();
    await openFromPlus(user);
    await user.keyboard("Map");
    await user.click(control("Status To Do"));
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(dialog()).toBeTruthy();
  });

  it.each([
    ["with rows", ENTRIES, ""],
    ["that no label matches", ENTRIES, "-"],
    ["of a project with no labels", [entry(1)], ""],
  ])("closes a label list %s alone", async (_kind, entries, typed) => {
    const user = userEvent.setup();
    setup({}, { entries });
    await openFromPlus(user);
    await user.keyboard("Map");
    await user.click(labelsTrigger());
    const input = await screen.findByPlaceholderText("Filter or add a label");
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    if (typed !== "") {
      await user.keyboard(typed);
    }

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(dialog()).toBeTruthy();
  });
});
