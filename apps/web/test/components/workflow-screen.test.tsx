import type { TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonKeys } from "../../src/api/queries";
import { refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const ORBIT = {
  name: "orbit",
  file: "/flows/orbit/workflow.yml",
  title: "Orbit review",
  steps: [
    { name: "orbit:draft", file: "/flows/orbit/steps/draft.md", owner: "agent" },
    { name: "crew:approve", file: "/flows/orbit/steps/approve.md", owner: "human" },
  ],
  instructions: ["/flows/shared.md", "/flows/orbit/rules.md"],
};

const INVALID = refusalReply(422, {
  kind: "store",
  code: "workflow-invalid",
  message: "the file is not valid YAML at line 3",
  path: "/flows/orbit/workflow.yml",
});

const UNKNOWN = refusalReply(400, {
  kind: "store",
  code: "workflow-unknown",
  message: "no workflow is named orbit",
  path: "/flows/orbit",
});

async function renderWorkflow(reply: TransportReply, name = "orbit") {
  const stub = stubTransport({ [`/workflows/${name}`]: reply });
  const router = await renderWithRouter(`/workflows/${name}`, stub.transport);

  return { ...stub, router };
}

function stepRows(): HTMLElement[] {
  const list = screen.getByRole("heading", { level: 2, name: "Steps" }).nextElementSibling as HTMLElement;

  expect(list.tagName).toBe("OL");
  return within(list).getAllByRole("listitem");
}

function instructionsCard(): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: "Workflow instructions" }).nextElementSibling as HTMLElement;
}

beforeEach(() => {
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  // renderWithRouter stubs scrollTo, which jsdom does not implement.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("links back to the list", async () => {
  await renderWorkflow(successReply(ORBIT));

  const back = within(screen.getByRole("main")).getByRole("link", { name: "Workflows" });

  expect(back.getAttribute("href")).toBe("/workflows");
});

it("heads the page with the title, marks the name beside it and shows the file", async () => {
  await renderWorkflow(successReply(ORBIT));

  const heading = screen.getByRole("heading", { level: 1 });

  expect(heading.textContent).toBe("Orbit review");
  expect(heading.nextElementSibling?.textContent).toBe("orbit");
  expect(screen.getByText("/flows/orbit/workflow.yml")).toBeTruthy();
  expect(document.title).toBe("Orbit review · tasma");
});

it.each(["", "  "])("heads the page with the name when the title is blank: %j", async (title) => {
  await renderWorkflow(successReply({ ...ORBIT, title }));

  const heading = screen.getByRole("heading", { level: 1 });

  expect(heading.textContent).toBe("orbit");
  expect(heading.nextElementSibling).toBeNull();
  expect(document.title).toBe("orbit · tasma");
});

it("heads the page with the name when the workflow has no title", async () => {
  await renderWorkflow(successReply({ ...ORBIT, title: undefined }));

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("orbit");
  expect(within(screen.getByRole("main")).getAllByText("orbit")).toHaveLength(1);
  expect(document.title).toBe("orbit · tasma");
});

it("lists the steps in order, each with its number, name, file and owner", async () => {
  await renderWorkflow(successReply(ORBIT));

  expect(stepRows().map((row) => row.textContent)).toEqual([
    "1orbit:draft/flows/orbit/steps/draft.mdagent",
    "2crew:approve/flows/orbit/steps/approve.mdhuman",
  ]);
});

it("lists the workflow instructions, and says None where there are none", async () => {
  await renderWorkflow(successReply(ORBIT));
  expect(instructionsCard().textContent).toBe("/flows/shared.md/flows/orbit/rules.md");

  cleanup();
  await renderWorkflow(successReply({ ...ORBIT, instructions: [] }));
  expect(instructionsCard().textContent).toBe("None");
});

it("builds the hint from the workflow's name and its last step", async () => {
  await renderWorkflow(successReply(ORBIT));

  const hint = screen.getByRole("note");

  expect(hint.textContent).toBe(
    "If you want to change this workflow, ask your agent, naming it and the change you want. For example:"
    + "Use the tasma skill. In the \"orbit\" workflow, add a step \"docs\" after \"crew:approve\", owned by an agent.",
  );
});

it("shows and announces the warnings of the read", async () => {
  await renderWorkflow(successReply(ORBIT, [{ code: "workflow-key-unknown", message: "unknown key: colour" }]));

  expect(within(screen.getByRole("main")).getByRole("heading", { level: 2, name: /warning/ }).textContent).toBe(
    "1 warning about this workflow",
  );
  expect(screen.getByRole("status").textContent).toBe("1 warning about this workflow.");
});

it("announces nothing for a read with nothing to report", async () => {
  await renderWorkflow(successReply(ORBIT));

  expect(screen.getByRole("status").textContent).toBe("");
});

it("shows a file the daemon could not parse as a fault, with the daemon's words", async () => {
  await renderWorkflow(INVALID);

  const main = screen.getByRole("main");

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("orbit");
  expect(within(main).getByText("/flows/orbit/workflow.yml")).toBeTruthy();
  expect(within(main).getByRole("heading", { level: 2 }).textContent).toBe("The daemon could not read this workflow");
  expect(main.textContent).toContain("Its steps and its instruction documents are unknown until the file is valid.");
  expect(main.textContent).toContain("the file is not valid YAML at line 3");
  expect(within(main).queryByRole("heading", { name: "Steps" })).toBeNull();
  expect(within(main).queryByRole("heading", { name: "Workflow instructions" })).toBeNull();
  expect(within(screen.getByRole("note")).getByText(
    "Use the tasma skill. In the \"orbit\" workflow, fix the file so it can be read.",
  )).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("This workflow was not read.");
});

// The daemon answered, so the address names a route: the not-found screen would
// say the opposite.
it("hands a workflow the daemon does not know to the failure panel", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await renderWorkflow(UNKNOWN);

  const alert = screen.getByRole("alert");

  expect(document.title).toBe("Request refused · tasma");
  expect(alert.textContent).toContain("store/workflow-unknown");
  expect(alert.textContent).toContain("no workflow is named orbit");
});

// A refusal is kept as the query's answer, so without its removal the next
// visit would read it back from the cache and never ask the daemon again.
it("asks the daemon again on the next visit after a refusal", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { router, paths, replies } = await renderWorkflow(UNKNOWN);

  replies["/workflows/orbit"] = successReply(ORBIT);
  await act(async () => {
    await router.navigate({ to: "/workflows" });
  });
  const asked = paths.length;
  await act(async () => {
    await router.navigate({ to: "/workflows/$workflow", params: { workflow: "orbit" } });
  });

  expect(paths.slice(asked)).toEqual(["/workflows/orbit"]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Orbit review");
});

it("turns the mounted page into the fault when a refetch finds the workflow gone", async () => {
  const { router, replies } = await renderWorkflow(successReply(ORBIT));

  replies["/workflows/orbit"] = UNKNOWN;
  await act(async () => {
    await router.options.context.queryClient.invalidateQueries({ queryKey: daemonKeys.workflowRead("orbit") });
  });

  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toBe("This workflow was not read.");
  });
  const main = screen.getByRole("main");
  expect(main.textContent).toContain("no workflow is named orbit");
  expect(main.textContent).not.toContain("/flows/orbit");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("orbit");
});

it.each([{ segment: ".." }, { segment: "." }, { segment: "%5C" }])(
  "hands the address /workflows/$segment to the not-found screen",
  async ({ segment }) => {
    const { transport, paths } = stubTransport();

    await renderWithRouter(`/workflows/${segment}`, transport);

    expect(screen.getByRole("main").textContent).toContain("names nothing the application can show");
    expect(paths.filter((path) => path.startsWith("/workflows"))).toEqual([]);
  },
);

it("moves focus to main after a navigation by the back link", async () => {
  const user = userEvent.setup();
  await renderWorkflow(successReply(ORBIT));

  await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Workflows" }));

  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workflows");
});
