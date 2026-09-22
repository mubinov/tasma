import { QueryClientProvider } from "@tanstack/react-query";
import { createClient, type Diagnostic, type TaskEntry, type TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import type { Created } from "../../src/api/mutations";
import { FIELD_TRIGGER_CLASS } from "../../src/components/control-classes";
import { CreateTaskDialog } from "../../src/components/create-task-dialog";
import { useNoticeStore } from "../../src/store/notices";
import { CONFIG, entry, listing } from "../board-fixtures";
import { heldBack, refusalReply, stubTransport, successReply } from "../helpers";
import { frame } from "../setup/notice-store";

const CREATE = "POST /projects/SAGA/tasks";

const ENTRIES = [entry(1, { labels: ["web"] }), entry(2, { labels: ["ops", "web"] })];

const CREATED = successReply({ id: "SAGA-7", status: "To Do" });

/**
 * Mounts the board's part: the two controls that open the dialog, and the state
 * that holds it open. `removePlus` takes the column's plus off the page while
 * the dialog is open.
 */
function setup(
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
  entries: readonly TaskEntry[] = ENTRIES,
) {
  const stub = stubTransport({ "/projects/SAGA/tasks": listing([...entries]), [CREATE]: CREATED, ...replies });
  const client = createClient(stub.transport);
  const queryClient = createAppQueryClient();
  const created: Created[] = [];

  function Board({ plus }: { plus: boolean }): ReactNode {
    const [creating, setCreating] = useState<{ status: string; opener: HTMLElement } | null>(null);
    const newTaskRef = useRef<HTMLButtonElement>(null);

    return (
      <QueryClientProvider client={queryClient}>
        <button
          ref={newTaskRef}
          type="button"
          onClick={(event) => {
            setCreating({ status: "Backlog", opener: event.currentTarget });
          }}
        >
          New task
        </button>
        {plus && (
          <button
            type="button"
            onClick={(event) => {
              setCreating({ status: "To Do", opener: event.currentTarget });
            }}
          >
            New task in To Do
          </button>
        )}
        {creating !== null && (
          <CreateTaskDialog
            queryClient={queryClient}
            client={client}
            tag="SAGA"
            config={CONFIG}
            entries={entries}
            status={creating.status}
            opener={creating.opener}
            newTaskRef={newTaskRef}
            onClose={() => {
              setCreating(null);
            }}
            onCreated={(result) => {
              created.push(result);
              setCreating(null);
            }}
          />
        )}
      </QueryClientProvider>
    );
  }

  const rendered = render(<Board plus />);

  return {
    ...stub,
    created,
    removePlus: () => {
      rendered.rerender(<Board plus={false} />);
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
    setup({}, entries);
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
