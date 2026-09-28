import type { TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonKeys } from "../../src/api/queries";
import { heldBack, refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const ORBIT = {
  name: "orbit",
  file: "/flows/orbit/workflow.yml",
  title: "Orbit review",
  steps: [{ name: "draft", file: "/flows/orbit/steps/draft.md", owner: "agent" }],
  instructions: [],
};

const RELAY = { ...ORBIT, name: "relay", file: "/flows/relay/workflow.yml", title: undefined };

const BROKEN = refusalReply(422, {
  kind: "store",
  code: "workflow-invalid",
  message: "the file is not valid YAML",
  path: "/flows/beacon/workflow.yml",
});

const MISSING = { code: "workflow-missing", message: "this directory holds no workflow.yml", path: "/flows/scratch" } as const;

const HINT_SENTENCE = "If you want to add a new workflow, ask your agent, naming what it is for. For example:";
const HINT_EXAMPLE = "Use the tasma skill. Create a tasma workflow for my engineering tasks.";

function daemon(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  return stubTransport({
    "/workflows": successReply(["orbit", "relay"]),
    "/workflows/orbit": successReply(ORBIT),
    "/workflows/relay": successReply(RELAY),
    ...replies,
  });
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Workflows" })).getAllByRole("link");
}

function rowFor(name: string): HTMLElement {
  return rows().find((row) => row.getAttribute("href") === `/workflows/${name}`)!;
}

beforeEach(() => {
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  // renderWithRouter stubs scrollTo, which jsdom does not implement.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("lists every workflow in the daemon's order, each with its title and its name", async () => {
  const { transport } = daemon({ "/workflows": successReply(["relay", "orbit"]) });
  await renderWithRouter("/workflows", transport);

  expect(rows().map((row) => row.getAttribute("href"))).toEqual(["/workflows/relay", "/workflows/orbit"]);
  expect(rowFor("orbit").textContent).toBe("Orbit revieworbit");
});

it("shows the name alone for a workflow with no title", async () => {
  await renderWithRouter("/workflows", daemon().transport);

  expect(rowFor("relay").textContent).toBe("relay");
});

it.each(["", "  "])("shows the name alone for a blank title: %j", async (title) => {
  const { transport } = daemon({ "/workflows/orbit": successReply({ ...ORBIT, title }) });
  await renderWithRouter("/workflows", transport);

  expect(rowFor("orbit").textContent).toBe("orbit");
});

it("marks a workflow the daemon could not read, and still links to its page", async () => {
  const { transport } = daemon({ "/workflows": successReply(["beacon", "orbit"]), "/workflows/beacon": BROKEN });
  await renderWithRouter("/workflows", transport);

  expect(rowFor("beacon").textContent).toBe("beaconThe daemon could not read this workflow. Open it to see why.");
});

it("lists a refused read first among the warnings, with its path", async () => {
  const user = userEvent.setup();
  const { transport } = daemon({
    "/workflows": successReply(["beacon", "orbit"], [MISSING]),
    "/workflows/beacon": BROKEN,
  });
  await renderWithRouter("/workflows", transport);

  await user.click(screen.getByRole("button", { name: "Show 2 warnings about the workflows" }));

  const items = within(screen.getByRole("list", { name: "2 warnings about the workflows" })).getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "workflow-invalidbeacon was not read: the file is not valid YAML/flows/beacon/workflow.yml",
    "workflow-missingthis directory holds no workflow.yml/flows/scratch",
  ]);
});

// Only a store refusal names a path.
it("lists a refusal of another kind with no path", async () => {
  const user = userEvent.setup();
  const { transport } = daemon({
    "/workflows": successReply(["beacon"]),
    "/workflows/beacon": refusalReply(500, { kind: "daemon", code: "internal", message: "the read failed" }),
  });
  await renderWithRouter("/workflows", transport);

  await user.click(screen.getByRole("button", { name: "Show 1 warning about the workflows" }));

  const [item] = within(screen.getByRole("list", { name: "1 warning about the workflows" })).getAllByRole("listitem");
  expect(item!.textContent).toBe("internalbeacon was not read: the read failed");
});

// A read's own warnings belong to its page, not to the list.
it("keeps the warnings of one read off the list", async () => {
  const { transport } = daemon({
    "/workflows/orbit": successReply(ORBIT, [{ code: "workflow-key-unknown", message: "unknown key: colour" }]),
  });
  await renderWithRouter("/workflows", transport);

  expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
});

it.each([
  { state: "with no warning", diagnostics: [], line: null },
  {
    state: "with a warning about the directory",
    diagnostics: [{ code: "workflows-path-unusable", message: "the directory is not readable", path: "/flows" }],
    line: "1 warning about the workflows",
  },
] as const)("says an empty directory is normal $state", async ({ diagnostics, line }) => {
  const { transport } = daemon({ "/workflows": successReply([], diagnostics) });
  await renderWithRouter("/workflows", transport);

  const main = screen.getByRole("main");
  expect(main.textContent).toContain("No workflows yet. The workflows directory holds none. Add one, and it is listed here.");
  expect(screen.queryByRole("list", { name: "Workflows" })).toBeNull();
  expect(within(main).queryByRole("heading", { level: 2 })?.textContent ?? null).toBe(line);
});

it.each([
  { state: "a list", names: ["orbit", "relay"] },
  { state: "an empty directory", names: [] },
])("shows the hint on $state", async ({ names }) => {
  const { transport } = daemon({ "/workflows": successReply(names) });
  await renderWithRouter("/workflows", transport);

  const hint = screen.getByRole("note");
  expect(within(hint).getByText(HINT_SENTENCE)).toBeTruthy();
  expect(within(hint).getByText(HINT_EXAMPLE)).toBeTruthy();
});

it("opens the main content with the heading Workflows and names the document", async () => {
  await renderWithRouter("/workflows", daemon().transport);

  const headings = screen.getAllByRole("heading", { level: 1 });

  expect(headings).toHaveLength(1);
  expect(headings[0]!.textContent).toBe("Workflows");
  expect(screen.getByRole("main").contains(headings[0]!)).toBe(true);
  expect(document.title).toBe("Workflows · tasma");
});

it("announces the warnings a refetch turns up", async () => {
  const { transport, replies } = daemon();
  const router = await renderWithRouter("/workflows", transport);

  expect(screen.getByRole("status").textContent).toBe("");

  replies["/workflows"] = successReply(["beacon", "orbit"], [MISSING]);
  replies["/workflows/beacon"] = BROKEN;
  await act(async () => {
    await router.options.context.queryClient.invalidateQueries({ queryKey: daemonKeys.all });
  });

  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toBe("2 warnings about the workflows.");
  });
});

it("shows a name a refetch adds while its read is on its way, and stays on screen", async () => {
  const late = heldBack();
  const { transport, replies } = daemon();
  const router = await renderWithRouter("/workflows", transport);

  replies["/workflows"] = successReply(["orbit", "relay", "vega"]);
  replies["/workflows/vega"] = late.reply;
  await act(async () => {
    await router.options.context.queryClient.invalidateQueries({ queryKey: daemonKeys.workflowList() });
  });

  await waitFor(() => {
    expect(rowFor("vega").textContent).toBe("vega");
  });
  expect(rowFor("orbit").textContent).toBe("Orbit revieworbit");

  late.answer(successReply({ ...ORBIT, name: "vega", title: "Vega launch" }));

  await waitFor(() => {
    expect(rowFor("vega").textContent).toBe("Vega launchvega");
  });
});

it("marks a name a refetch adds whose read reaches no daemon", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { transport, replies } = daemon();
  const router = await renderWithRouter("/workflows", transport);

  replies["/workflows"] = successReply(["orbit", "relay", "vega"]);
  replies["/workflows/vega"] = { status: 502, body: "bad gateway" };
  await act(async () => {
    await router.options.context.queryClient.invalidateQueries({ queryKey: daemonKeys.workflowList() });
  });
  // Past the one retry a transport failure gets.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  await waitFor(() => {
    expect(rowFor("vega").textContent).toBe("vegaThe daemon could not read this workflow. Open it to see why.");
  });
  expect(rowFor("orbit").textContent).toBe("Orbit revieworbit");
});

it.each([
  { state: "drops its name", names: ["relay"] },
  { state: "empties the list", names: [] },
])("moves focus to main when a refetch $state under the focused row", async ({ names }) => {
  const { transport, replies } = daemon();
  const router = await renderWithRouter("/workflows", transport);

  rowFor("orbit").focus();
  replies["/workflows"] = successReply(names);
  await act(async () => {
    await router.options.context.queryClient.invalidateQueries({ queryKey: daemonKeys.workflowList() });
  });

  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

it("opens a workflow's page from its row", async () => {
  const user = userEvent.setup();
  await renderWithRouter("/workflows", daemon().transport);

  await user.click(rowFor("orbit"));

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Orbit review");
});

it("hands a list that reached no daemon to the failure panel", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { transport } = daemon({ "/workflows": { status: 502, body: "bad gateway" } });

  await renderWithRouter("/workflows", transport);

  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Workflows" })).toBeNull();
});
