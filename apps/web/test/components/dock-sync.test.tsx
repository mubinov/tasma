import { createClient, type AgentState } from "@tasma/protocol";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { dockAvailable, sendDockState } from "../../src/api/dock";
import { daemonKeys } from "../../src/api/queries";
import { DockSync } from "../../src/components/dock-sync";
import { refusalReply, stubTransport, successReply } from "../helpers";

const STATE = "/chats/state";
const REFUSAL = refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" });
const PAGE = "The rest of the page";

function stateReply(state: AgentState) {
  return successReply({ state });
}

function stubShell(answer: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 202 }))) {
  const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(answer);
  vi.stubGlobal("fetch", fetch);

  return {
    posted: () => fetch.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${input}`),
  };
}

function mount(stub: ReturnType<typeof stubTransport>) {
  const queryClient = createAppQueryClient();

  const { container } = render(
    <>
      <DockSync queryClient={queryClient} client={createClient(stub.transport)} />
      <p>{PAGE}</p>
    </>,
  );

  return {
    page: () => container.textContent,
    readCount: () => stub.paths.filter((path) => path === STATE).length,
    readAgain: () => queryClient.invalidateQueries({ queryKey: daemonKeys.agentState() }),
    settled: async () => {
      await waitFor(() => {
        const query = queryClient.getQueryState(daemonKeys.agentState());

        expect(query?.fetchStatus).toBe("idle");
        expect(query?.status).not.toBe("pending");
      });
      // query-core tells its observers on a zero timer, and the render follows it.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("sends the state of the first answer to the app", async () => {
  const shell = stubShell();
  mount(stubTransport({ [STATE]: stateReply("needs-you") }));

  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/dock/needs-you"]);
  });
});

it("sends a changed state one time", async () => {
  const shell = stubShell();
  const stub = stubTransport({ [STATE]: stateReply("off") });
  const view = mount(stub);
  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/dock/off"]);
  });

  stub.replies[STATE] = stateReply("running");
  await view.readAgain();

  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/dock/off", "POST /app/dock/running"]);
  });
});

it("sends nothing when a read again gives the same state", async () => {
  const shell = stubShell();
  const view = mount(stubTransport({ [STATE]: stateReply("running") }));
  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/dock/running"]);
  });

  await view.readAgain();
  await view.settled();

  expect(view.readCount()).toBe(2);
  expect(shell.posted()).toEqual(["POST /app/dock/running"]);
});

it("sends nothing when the first read fails", async () => {
  const shell = stubShell();
  const view = mount(stubTransport({ [STATE]: REFUSAL }));

  await view.settled();

  expect(view.readCount()).toBe(1);
  expect(shell.posted()).toEqual([]);
});

it.each([
  [null],
  ["off"],
  [1],
  [["off"]],
  [{}],
  [{ state: null }],
  [{ state: 1 }],
  [{ state: ["off"] }],
  [{ state: { toString: 1, valueOf: 1 } }],
  [{ state: "../update/install" }],
  [{ state: "../folder" }],
  [{ state: "constructor" }],
  [{ state: "__proto__" }],
])("sends nothing and keeps the page for the answer %j, which is no state", async (answer) => {
  const shell = stubShell();
  const view = mount(stubTransport({ [STATE]: successReply(answer) }));

  await view.settled();

  expect(shell.posted()).toEqual([]);
  expect(view.page()).toBe(PAGE);
});

it("sends nothing when a read again fails", async () => {
  const shell = stubShell();
  const stub = stubTransport({ [STATE]: stateReply("running") });
  const view = mount(stub);
  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/dock/running"]);
  });

  stub.replies[STATE] = REFUSAL;
  await view.readAgain();
  await view.settled();

  expect(view.readCount()).toBe(2);
  expect(shell.posted()).toEqual(["POST /app/dock/running"]);
});

it("ignores a request the app does not answer", async () => {
  stubShell(() => Promise.reject(new TypeError("Load failed")));

  await expect(sendDockState("running")).resolves.toBeUndefined();
});

it("ignores a request the app refuses", async () => {
  stubShell(() => Promise.resolve(new Response(null, { status: 404 })));

  await expect(sendDockState("running")).resolves.toBeUndefined();
});

it("is available only on the origin the macOS app serves", () => {
  vi.stubGlobal("location", { protocol: "tasma-app:" });
  expect(dockAvailable()).toBe(true);

  vi.stubGlobal("location", { protocol: "http:" });
  expect(dockAvailable()).toBe(false);
});
