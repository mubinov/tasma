import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createClient } from "@tasma/protocol";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { UPDATE_EVENT } from "../../src/api/paths";
import { CreateTaskDialog } from "../../src/components/create-task-dialog";
import { UpdateEvents } from "../../src/components/update-events";
import { useUiStore } from "../../src/store/ui";
import { CONFIG } from "../board-fixtures";
import { stubTransport } from "../helpers";
import { AVAILABLE, dispatch, renderApp, resetUpdateUi, spoken, stubApp } from "../update-fixtures";

beforeEach(resetUpdateUi);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the versions and the release page in the update dialog", async () => {
  stubApp(AVAILABLE);
  const user = userEvent.setup();
  await renderApp();

  await user.click(await screen.findByRole("button", { name: "Update to 0.2.0" }));

  const dialog = screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is available" });
  expect(dialog.textContent).toContain("Current version: 0.1.0. Tasma restarts to install the update.");
  const link = within(dialog).getByRole("link", { name: "Release page" });
  expect(link.getAttribute("href")).toBe("https://example.invalid/releases/tag/v0.2.0");
  expect(link.getAttribute("target")).toBe("_blank");
});

it("starts the install from the update dialog and says so", async () => {
  const app = stubApp(AVAILABLE);
  const user = userEvent.setup();
  await renderApp();

  await user.click(await screen.findByRole("button", { name: "Update to 0.2.0" }));
  await user.click(screen.getByRole("button", { name: "Install and restart" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(app.posted()).toEqual(["POST /app/update/install"]);
  await waitFor(() => {
    expect(spoken()).toEqual(["Installing Tasma 0.2.0."]);
  });
});

it.each([
  ["refuses", 409 as const],
  ["cannot be reached", "unreachable" as const],
])("says the update could not start when the app %s", async (_name, status) => {
  const app = stubApp(AVAILABLE);
  app.statuses["/app/update/install"] = status;
  const user = userEvent.setup();
  await renderApp();

  await user.click(await screen.findByRole("button", { name: "Update to 0.2.0" }));
  await user.click(screen.getByRole("button", { name: "Install and restart" }));

  await waitFor(() => {
    expect(spoken()).toEqual(["The update could not start."]);
  });
});

it("names the reason of a failed update and tries again from its dialog", async () => {
  const app = stubApp({ ...AVAILABLE, state: "failed", error: "The download failed." });
  const user = userEvent.setup();
  await renderApp();

  await user.click(await screen.findByRole("button", { name: "Update failed" }));

  const dialog = screen.getByRole("alertdialog", { name: "The update to 0.2.0 failed" });
  expect(dialog.textContent).toContain("The download failed. Tasma 0.1.0 is still installed.");

  await user.click(within(dialog).getByRole("button", { name: "Try again" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(app.posted()).toEqual(["POST /app/update/install"]);
});

it("restarts from the restart dialog, and keeps it open with the reason when the restart fails", async () => {
  const app = stubApp({ ...AVAILABLE, state: "ready" });
  const user = userEvent.setup();
  await renderApp();

  await user.click(await screen.findByRole("button", { name: "Restart to update" }));

  const dialog = screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is installed" });
  expect(dialog.textContent).toContain(
    "Tasma must restart to finish the update. Unsaved text is lost when it restarts.",
  );
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Later" }));
  });

  await user.click(within(dialog).getByRole("button", { name: "Restart now" }));
  expect(app.posted()).toEqual(["POST /app/update/restart"]);

  app.statuses["/app/update/restart"] = 409;
  await user.click(within(dialog).getByRole("button", { name: "Restart now" }));

  await waitFor(() => {
    expect(dialog.textContent).toContain("Tasma could not restart. Quit Tasma and open it again.");
  });
  await waitFor(() => {
    expect(spoken()).toEqual(["Tasma could not restart. Quit Tasma and open it again."]);
  });
  expect(screen.getByRole("alertdialog")).toBe(dialog);

  await user.click(within(dialog).getByRole("button", { name: "Later" }));
  await user.click(screen.getByRole("button", { name: "Restart to update" }));
  expect(screen.getByRole("alertdialog").textContent).not.toContain("could not restart");
});

it("opens the update dialog a menu check asks for, and returns focus where it was", async () => {
  stubApp(AVAILABLE);
  const user = userEvent.setup();
  await renderApp();
  const settings = screen.getByRole("link", { name: "Settings" });
  settings.focus();

  await dispatch({ open: true });

  const dialog = screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is available" });
  await user.click(within(dialog).getByRole("button", { name: "Later" }));

  expect(document.activeElement).toBe(settings);
});

/** Dispatches as the app does, outside `act`, so the query notifies observers on its own schedule. */
async function dispatchFromApp(detail: object) {
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail }));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

it("keeps open the update dialog a menu check asks for while the cache still holds the earlier state", async () => {
  const app = stubApp({ state: "none", current: "0.1.0" });
  await renderApp();
  await waitFor(() => {
    expect(app.requests).toContain("GET /app/update");
  });

  app.set(AVAILABLE);
  await dispatchFromApp({ open: true });

  expect(screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is available" })).toBeTruthy();
});

it("keeps open the restart dialog while the cache still holds the install", async () => {
  const app = stubApp({ ...AVAILABLE, state: "installing", progress: 90 });
  await renderApp();
  expect(await screen.findByText("90%")).toBeTruthy();
  useUiStore.setState({ unsavedPage: true });

  app.set({ ...AVAILABLE, state: "ready" });
  await dispatchFromApp({ restart: true });

  expect(screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is installed" })).toBeTruthy();
  expect(app.posted()).toEqual(["POST /app/update/wait"]);
});

it("opens the dialogs where no sidebar is shown", async () => {
  const app = stubApp(AVAILABLE);
  const user = userEvent.setup();
  render(<UpdateEvents queryClient={createAppQueryClient()} />);

  await dispatch({ open: true });

  const dialog = await screen.findByRole("alertdialog", { name: "Tasma 0.2.0 is available" });
  await user.click(within(dialog).getByRole("button", { name: "Install and restart" }));

  expect(app.posted()).toEqual(["POST /app/update/install"]);
});

it("leaves the update to the item while another modal dialog is open", async () => {
  stubApp(AVAILABLE);
  await renderApp();
  useUiStore.setState({ modalDialogs: 1 });

  await dispatch({ open: true });

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(await screen.findByRole("button", { name: "Update to 0.2.0" })).toBeTruthy();
});

it("ignores an event that carries no detail it knows", async () => {
  const app = stubApp(AVAILABLE);
  await renderApp();

  await act(async () => {
    window.dispatchEvent(new Event(UPDATE_EVENT));
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: "open" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(app.posted()).toEqual([]);
});

it("reads nothing more from an event when no app answers", async () => {
  const app = stubApp("unreachable");
  await renderApp();

  await dispatch({ open: true, restart: true });

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(app.posted()).toEqual([]);
});

it("restarts at once when nothing would be lost", async () => {
  const app = stubApp({ ...AVAILABLE, state: "ready" });
  await renderApp();

  await dispatch({ restart: true });

  expect(app.posted()).toEqual(["POST /app/update/restart"]);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("says so when a restart nothing would lose fails", async () => {
  const app = stubApp({ ...AVAILABLE, state: "ready" });
  app.statuses["/app/update/restart"] = "unreachable";
  await renderApp();

  await dispatch({ restart: true });

  await waitFor(() => {
    expect(spoken()).toEqual(["Tasma could not restart. Quit Tasma and open it again."]);
  });
});

it("asks before a restart while an editor of the task page holds unsaved text", async () => {
  const app = stubApp({ ...AVAILABLE, state: "ready" });
  const user = userEvent.setup();
  await renderApp();
  useUiStore.setState({ unsavedPage: true });

  await dispatch({ restart: true });

  expect(app.posted()).toEqual(["POST /app/update/wait"]);
  const dialog = screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is installed" });

  await user.click(within(dialog).getByRole("button", { name: "Later" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(app.posted()).toEqual(["POST /app/update/wait"]);
});

it("waits and says where to restart while another modal dialog is open", async () => {
  const app = stubApp({ ...AVAILABLE, state: "ready" });
  await renderApp();
  useUiStore.setState({ modalDialogs: 1, unsavedPage: true });

  await dispatch({ restart: true });

  expect(app.posted()).toEqual(["POST /app/update/wait"]);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => {
    expect(spoken()).toEqual(["Tasma 0.2.0 is installed. Restart from the sidebar."]);
  });
});

/** The create-task dialog, open, as the board mounts it. */
function CreateTask({ queryClient }: { queryClient: QueryClient }): ReactNode {
  const newTaskRef = useRef<HTMLButtonElement>(null);

  return (
    <QueryClientProvider client={queryClient}>
      <button ref={newTaskRef} type="button">New task</button>
      <CreateTaskDialog
        queryClient={queryClient}
        client={createClient(stubTransport({}).transport)}
        tag="SAGA"
        config={CONFIG}
        entries={[]}
        status="To Do"
        opener={document.body}
        newTaskRef={newTaskRef}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    </QueryClientProvider>
  );
}

it.each([
  ["empty", ""],
  ["holding a draft", "Map the cellar"],
])("counts the create-task dialog %s as a modal dialog", async (_name, typed) => {
  const app = stubApp({ ...AVAILABLE, state: "ready" });
  const user = userEvent.setup();
  await renderApp();
  render(<CreateTask queryClient={createAppQueryClient()} />);
  await screen.findByRole("dialog", { name: "New task" });
  if (typed !== "") {
    await user.type(screen.getByRole("textbox", { name: "Title" }), typed);
  }

  await dispatch({ restart: true });

  expect(app.posted()).toEqual(["POST /app/update/wait"]);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => {
    expect(spoken()).toEqual(["Tasma 0.2.0 is installed. Restart from the sidebar."]);
  });

  app.set(AVAILABLE);
  await dispatch({ open: true });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("sends a failed wait one more time", async () => {
  const app = stubApp({ ...AVAILABLE, state: "ready" });
  app.statuses["/app/update/wait"] = 409;
  await renderApp();
  useUiStore.setState({ unsavedPage: true });

  await dispatch({ restart: true });

  await waitFor(() => {
    expect(app.posted()).toEqual(["POST /app/update/wait", "POST /app/update/wait"]);
  });
});

it("announces a failed update once, and no progress at all", async () => {
  const app = stubApp({ ...AVAILABLE, state: "installing", progress: 10 });
  await renderApp();

  await dispatch({});
  app.set({ ...AVAILABLE, state: "installing", progress: 60 });
  await dispatch({});
  expect(await screen.findByText("60%")).toBeTruthy();

  app.set({ ...AVAILABLE, state: "failed", error: "The download failed." });
  await dispatch({});
  await dispatch({});

  await waitFor(() => {
    expect(spoken()).toEqual(["The update to 0.2.0 failed. The download failed."]);
  });
});

it("closes a dialog whose state has passed, and does not open it again", async () => {
  const app = stubApp(AVAILABLE);
  const user = userEvent.setup();
  await renderApp();

  await user.click(await screen.findByRole("button", { name: "Update to 0.2.0" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();

  app.set({ ...AVAILABLE, state: "installing", progress: 0 });
  await dispatch({});
  await waitFor(() => {
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  expect(useUiStore.getState().updateDialog).toBeNull();

  app.set(AVAILABLE);
  await dispatch({});
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
