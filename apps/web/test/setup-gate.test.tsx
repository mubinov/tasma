import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { TransportError, type Transport } from "@tasma/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppRouter } from "../src/routes";
import { useUiStore } from "../src/store/ui";
import {
  advance,
  completeSetup,
  heldBack,
  refusalReply,
  renderWithRouter,
  setupStatus,
  stubTransport,
  successReply,
  testContext,
} from "./helpers";

const START = "/setup?mode=start";
const FULL = "/setup?mode=full";

const EMPTY_TREE = setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" });

const REFUSED = refusalReply(500, { kind: "daemon", code: "internal", message: "the check broke" });

function mount(path: string, transport: Transport) {
  vi.stubGlobal("scrollTo", () => {});
  const context = testContext(transport);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }), context);

  render(
    <QueryClientProvider client={context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return router;
}

beforeEach(() => {
  useUiStore.setState({ skillCheckStopped: false, arrivalWords: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("opens the setup screen on an empty tree, with no sidebar", async () => {
  const { transport } = stubTransport({ [START]: successReply(EMPTY_TREE), [FULL]: successReply(EMPTY_TREE) });
  const router = await renderWithRouter("/", transport);

  expect(router.state.location.pathname).toBe("/setup");
  expect(screen.getByRole("heading", { level: 1, name: "Set up Tasma" })).toBeTruthy();
  expect(screen.queryByRole("navigation")).toBeNull();
});

it("replaces the entry of the first address, so Back does not lead to it", async () => {
  const { transport } = stubTransport({ [START]: successReply(EMPTY_TREE), [FULL]: successReply(EMPTY_TREE) });
  const router = await renderWithRouter("/", transport);

  expect(router.history.length).toBe(1);
});

it("opens the requested route on a complete setup, with one start read and no full read", async () => {
  const { transport, paths } = stubTransport();
  const router = await renderWithRouter("/", transport);

  expect(router.state.location.pathname).toBe("/");
  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  expect(paths.filter((path) => path.startsWith("/setup"))).toEqual([START]);
});

it("sends the skip flag at start after the check stopped", async () => {
  useUiStore.setState({ skillCheckStopped: true });
  const { transport, paths } = stubTransport({ "/setup?mode=start&skipSkill=true": completeSetup() });
  const router = await renderWithRouter("/", transport);

  expect(router.state.location.pathname).toBe("/");
  expect(paths.filter((path) => path.startsWith("/setup"))).toEqual(["/setup?mode=start&skipSkill=true"]);
});

it("does not open the setup screen for a skill miss after the check stopped", async () => {
  useUiStore.setState({ skillCheckStopped: true });
  const { transport } = stubTransport({
    "/setup?mode=start&skipSkill=true": successReply(setupStatus({}, { skill: "fail" })),
  });
  const router = await renderWithRouter("/", transport);

  expect(router.state.location.pathname).toBe("/");
});

it.each(["unknown", "not-run"] as const)("does not open the setup screen for %s", async (check) => {
  const { transport } = stubTransport({
    [START]: successReply(setupStatus({ project: check, workflow: check }, { skill: check })),
  });
  const router = await renderWithRouter("/", transport);

  expect(router.state.location.pathname).toBe("/");
});

it("goes on to the route when the daemon refuses the start read", async () => {
  const { transport } = stubTransport({ [START]: REFUSED });
  const router = await renderWithRouter("/", transport);

  expect(router.state.location.pathname).toBe("/");
  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
});

it("shows the failure of the route with Retry when the start read fails, and Retry reads again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
  const stub = stubTransport();
  let down = true;
  const transport: Transport = (request) =>
    down ? Promise.reject(new TransportError("no daemon")) : stub.transport(request);

  mount("/", transport);
  await advance(5000);

  const retry = await screen.findByRole("button", { name: "Retry" });

  expect(screen.getByRole("navigation")).toBeTruthy();
  expect(screen.getByRole("main").contains(retry)).toBe(true);

  down = false;
  await user.click(retry);
  await advance(100);

  await waitFor(() => {
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  });
  expect(stub.paths.filter((path) => path === START)).toHaveLength(1);
});

it("stays on a first navigation to /setup with a failing status", async () => {
  const { transport } = stubTransport({ [START]: successReply(EMPTY_TREE), [FULL]: successReply(EMPTY_TREE) });
  const router = await renderWithRouter("/setup", transport);

  expect(router.state.location.pathname).toBe("/setup");
  expect(screen.getByRole("heading", { level: 1, name: "Set up Tasma" })).toBeTruthy();
});

it("ends on the Tasks page on a first navigation to /setup with a passing status", async () => {
  const { transport } = stubTransport();
  const router = await renderWithRouter("/setup", transport);

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/tasks");
  });
  expect(router.history.length).toBe(1);
});

it("opens the setup screen when a refused start read at /setup is followed by a failing status", async () => {
  const stub = stubTransport({ [FULL]: successReply(EMPTY_TREE) });
  const starts = [REFUSED, successReply(EMPTY_TREE)];
  const transport: Transport = (request) =>
    request.path === START ? Promise.resolve(starts.shift()!) : stub.transport(request);
  const router = await renderWithRouter("/setup", transport);

  await waitFor(() => {
    expect(screen.getByRole("heading", { level: 1, name: "Set up Tasma" })).toBeTruthy();
  });
  expect(router.state.location.pathname).toBe("/setup");
  expect(stub.paths).toContain(FULL);
});

it("sends no read on a second navigation, also after 5 minutes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { transport, paths } = stubTransport();
  const router = await renderWithRouter("/", transport);

  await act(async () => {
    await router.navigate({ to: "/settings" });
  });
  await advance(6 * 60_000);
  await act(async () => {
    await router.navigate({ to: "/projects" });
  });

  expect(router.state.location.pathname).toBe("/projects");
  expect(paths.filter((path) => path.startsWith("/setup"))).toEqual([START]);
});

it("does not open the screen during a session after a later answer fails", async () => {
  const stub = stubTransport();
  const router = await renderWithRouter("/", stub.transport);

  stub.replies[START] = successReply(EMPTY_TREE);
  await act(async () => {
    await router.options.context.queryClient.invalidateQueries();
    await router.navigate({ to: "/settings" });
  });

  expect(router.state.location.pathname).toBe("/settings");
});

it("shows no loader for a start under 300 ms", async () => {
  vi.useFakeTimers();
  const { reply, answer } = heldBack();
  const { transport } = stubTransport({ [START]: reply });

  mount("/", transport);
  await advance(299);

  expect(screen.queryByRole("status")).toBeNull();

  answer(completeSetup());
  await advance(1000);

  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  expect(screen.queryByText("Checking the setup")).toBeNull();
});

it("shows the loader after 300 ms, and for at least 600 ms", async () => {
  vi.useFakeTimers();
  const { reply, answer } = heldBack();
  const { transport } = stubTransport({ [START]: reply });

  mount("/", transport);
  await advance(320);

  expect(screen.getByRole("status").textContent).toBe("Checking the setup");
  expect(screen.queryByRole("navigation")).toBeNull();

  answer(completeSetup());
  await advance(400);

  expect(screen.getByRole("status").textContent).toBe("Checking the setup");

  await advance(400);

  expect(screen.queryByText("Checking the setup")).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
});

it("keeps one loader through the data of the first screen", async () => {
  vi.useFakeTimers();
  const start = heldBack();
  const projects = heldBack();
  const { transport } = stubTransport({ [START]: start.reply, "/projects": projects.reply });

  mount("/", transport);
  await advance(320);
  start.answer(completeSetup());
  await advance(2000);

  expect(screen.getByRole("status").textContent).toBe("Checking the setup");
  expect(screen.queryByRole("navigation")).toBeNull();

  projects.answer(successReply([]));
  await advance(100);

  expect(screen.queryByText("Checking the setup")).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
});

it("renders the loader with no main, so a task link waits for the board", async () => {
  vi.useFakeTimers();
  const { reply } = heldBack();
  const { transport } = stubTransport({ [START]: reply });

  mount("/", transport);
  await advance(320);

  expect(screen.getByRole("status").textContent).toBe("Checking the setup");
  expect(document.querySelector("main")).toBeNull();
});

it("mounts the words of the loader one frame after the region", async () => {
  vi.useFakeTimers();
  const { reply } = heldBack();
  const { transport } = stubTransport({ [START]: reply });

  mount("/", transport);
  await advance(300);

  expect(screen.getByRole("status").textContent).toBe("");

  await advance(20);

  expect(screen.getByRole("status").textContent).toBe("Checking the setup");
});

it("does not show the loader on a later navigation", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { reply } = heldBack();
  const stub = stubTransport();
  const router = await renderWithRouter("/", stub.transport);

  stub.replies["/workflows"] = reply;
  void act(() => {
    void router.navigate({ to: "/workflows" });
  });
  await advance(2000);

  expect(screen.queryByText("Checking the setup")).toBeNull();
  expect(screen.getByRole("navigation")).toBeTruthy();
});

it("shows no loader when only the data of the first screen is slow", async () => {
  vi.useFakeTimers();
  const projects = heldBack();
  const { transport } = stubTransport({ "/projects": projects.reply });

  mount("/", transport);
  await advance(2000);

  expect(screen.queryByRole("status")).toBeNull();

  projects.answer(successReply([]));
  await advance(100);

  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
});
