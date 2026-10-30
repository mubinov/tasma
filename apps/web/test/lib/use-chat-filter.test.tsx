import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createClient, type ProjectSummary } from "@tasma/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { daemonKeys, type ChatFilter } from "../../src/api/queries";
import { chatFilterOf, filterKey, sameFilter, useChatFilter } from "../../src/lib/use-chat-filter";
import { heldBack, refusalReply, stubTransport, successReply } from "../helpers";

const PROJECTS: readonly ProjectSummary[] = [{ tag: "ACME", name: "Acme" }, { tag: "SAGA" }];

const BROKEN = refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" });

function page(task: string) {
  return successReply({ items: [{ tag: "ACME", task, title: "Ship", chat: 1, step: "build", agent: "claude", created: "2026-09-01T10:00:00.000Z" }], total: 1, active: 0 });
}

afterEach(() => {
  cleanup();
});

describe("chatFilterOf", () => {
  it("keeps a project of the list and the trimmed text of a search", () => {
    expect(chatFilterOf({ project: "ACME", q: "  ship it " }, PROJECTS)).toEqual({ project: "ACME", q: "ship it" });
  });

  it("leaves out a project that the list does not hold, and a search of spaces", () => {
    expect(chatFilterOf({ project: "BETA", q: "   " }, PROJECTS)).toEqual({});
    expect(chatFilterOf({}, PROJECTS)).toEqual({});
  });
});

describe("sameFilter and filterKey", () => {
  it("tell the filters apart by the project and the search", () => {
    const filters: ChatFilter[] = [{}, { project: "ACME" }, { q: "ACME" }, { project: "ACME", q: "ship" }];

    for (const one of filters) {
      for (const other of filters) {
        expect(sameFilter(one, other)).toBe(one === other);
        expect(filterKey(one) === filterKey(other)).toBe(one === other);
      }
    }
    expect(sameFilter({ project: "ACME" }, { project: "ACME" })).toBe(true);
    expect(filterKey({ project: "ACME" })).toBe(filterKey({ project: "ACME" }));
  });
});

type Search = { project?: string; q?: string };

function mount(replies: Parameters<typeof stubTransport>[0], search: Search = {}) {
  const stub = stubTransport(replies);
  const client = createClient(stub.transport);
  const queryClient = createAppQueryClient();

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  const view = renderHook((current: Search) => useChatFilter(client, current, PROJECTS), {
    initialProps: search,
    wrapper,
  });
  return { ...view, stub, queryClient };
}

/** Reads the chats again, as a feed event does. */
async function readAgain(queryClient: QueryClient): Promise<void> {
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: daemonKeys.chats() });
  });
}

describe("useChatFilter", () => {
  it("applies the filter of the address at mount, and reads nothing for it", () => {
    const { result, stub } = mount({}, { project: "ACME", q: "ship" });

    expect(result.current.requested).toEqual({ project: "ACME", q: "ship" });
    expect(result.current.applied).toEqual({ project: "ACME", q: "ship" });
    expect(result.current.failed).toBe(false);
    expect(stub.paths).toEqual([]);
  });

  it("keeps the applied filter while the requested one is read, and applies it when its first page comes", async () => {
    const read = heldBack();
    const { result, rerender, stub } = mount({ "/chats?q=ship": read.reply });

    rerender({ q: "ship" });

    expect(result.current.requested).toEqual({ q: "ship" });
    expect(result.current.applied).toEqual({});
    expect(stub.paths).toEqual(["/chats?q=ship"]);

    read.answer(page("ACME-7"));

    await waitFor(() => {
      expect(result.current.applied).toEqual({ q: "ship" });
    });
    expect(result.current.failed).toBe(false);
  });

  it("applies at once a requested filter whose first page is in the cache", async () => {
    const { result, rerender } = mount({ "/chats?project=ACME": page("ACME-7") });
    rerender({ project: "ACME" });
    await waitFor(() => {
      expect(result.current.applied).toEqual({ project: "ACME" });
    });

    rerender({});
    rerender({ project: "ACME" });

    expect(result.current.applied).toEqual({ project: "ACME" });
  });

  it("counts a failed read of the requested filter, and names the fields that differ from the applied one", async () => {
    const { result, rerender } = mount({ "/chats?project=ACME&q=ship": BROKEN }, { q: "build" });

    rerender({ project: "ACME", q: "ship" });

    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });
    expect(result.current.failures).toBe(1);
    expect(result.current.applied).toEqual({ q: "build" });
    expect(result.current.failedFields).toEqual({ search: true, project: true });
  });

  it("names only the field that differs", async () => {
    const { result, rerender } = mount({ "/chats?project=ACME": BROKEN });

    rerender({ project: "ACME" });

    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });
    expect(result.current.failedFields).toEqual({ search: false, project: true });
  });

  it("reads the requested filter again on retry, keeps the failure while it reads, and applies the result", async () => {
    const { result, rerender, stub } = mount({ "/chats?q=ship": BROKEN });
    rerender({ q: "ship" });
    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });
    const again = heldBack();
    stub.replies["/chats?q=ship"] = again.reply;

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(stub.paths.filter((path) => path === "/chats?q=ship")).toHaveLength(2);
    });
    expect(result.current.failed).toBe(true);

    again.answer(page("ACME-7"));

    await waitFor(() => {
      expect(result.current.applied).toEqual({ q: "ship" });
    });
    expect(result.current.failed).toBe(false);
    expect(result.current.failures).toBe(0);
  });

  it("ends the failure when the requested filter goes back to the applied one, and counts again from zero for it", async () => {
    const { result, rerender, stub } = mount({ "/chats?q=ship": BROKEN });
    rerender({ q: "ship" });
    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });

    rerender({});

    expect(result.current.failed).toBe(false);
    expect(result.current.failures).toBe(0);

    const again = heldBack();
    stub.replies["/chats?q=ship"] = again.reply;
    rerender({ q: "ship" });

    expect(result.current.failed).toBe(false);
    again.answer(BROKEN);

    await waitFor(() => {
      expect(result.current.failures).toBe(1);
    });
  });

  it("announces the first failure and a failure of a read that retry starts, and no other failure", async () => {
    const { result, rerender, queryClient } = mount({ "/chats?q=ship": BROKEN });
    expect(result.current.announceFailure).toBe(false);
    rerender({ q: "ship" });
    await waitFor(() => {
      expect(result.current.failures).toBe(1);
    });
    expect(result.current.announceFailure).toBe(true);

    await readAgain(queryClient);
    await waitFor(() => {
      expect(result.current.failures).toBe(2);
    });
    expect(result.current.announceFailure).toBe(false);

    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.failures).toBe(3);
    });
    expect(result.current.announceFailure).toBe(true);

    await readAgain(queryClient);
    await waitFor(() => {
      expect(result.current.failures).toBe(4);
    });
    expect(result.current.announceFailure).toBe(false);
  });

  it("forgets a retry when the requested filter changes", async () => {
    const { result, rerender, queryClient } = mount({ "/chats?q=ship": BROKEN });
    rerender({ q: "ship" });
    await waitFor(() => {
      expect(result.current.failures).toBe(1);
    });
    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.failures).toBe(2);
    });

    rerender({});
    rerender({ q: "ship" });
    await waitFor(() => {
      expect(result.current.failures).toBe(1);
    });
    await readAgain(queryClient);

    await waitFor(() => {
      expect(result.current.failures).toBe(2);
    });
    expect(result.current.announceFailure).toBe(false);
  });
});
