import { focusManager } from "@tanstack/react-query";
import type { AgentSetup, ChatAgent, SetupStatus } from "@tasma/protocol";
import { act, cleanup, renderHook, waitFor, type RenderHookResult } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { daemonKeys, setupQuery } from "../../src/api/queries";
import type { RouterContext } from "../../src/routes";
import { useNewChatAgent, type NewChatAgent, type NewChatAgentInput } from "../../src/lib/use-new-chat-agent";
import { heldBack, routerWrapper, setupStatus, startOf, stubTransport, successReply, testContext } from "../helpers";

const FULL = "/setup?mode=full&skipSkill=true";

const CLAUDE: AgentSetup = { agent: "claude", installed: "pass", loggedIn: "pass", skill: "pass" };

const CODEX: AgentSetup = { agent: "codex", installed: "pass", loggedIn: "pass", skill: "pass" };

const CODEX_LOGGED_OUT: AgentSetup = { ...CODEX, loggedIn: "fail" };

const CLAUDE_LOGGED_OUT: AgentSetup = { ...CLAUDE, loggedIn: "fail" };

type Stub = ReturnType<typeof stubTransport>;

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
});

function fullReads(stub: Stub): number {
  return stub.requests.filter(({ method, path }) => method === "GET" && path === FULL).length;
}

function status(agents: AgentSetup[], defaultAgent?: ChatAgent): SetupStatus {
  return setupStatus({ agents, ...(defaultAgent === undefined ? {} : { defaultAgent }) });
}

/** A daemon whose full read answers `answer`, and a context whose cache holds the start read that the gate made. */
function daemon(offered: AgentSetup[] | null, answer?: SetupStatus): { stub: Stub; context: RouterContext } {
  const stub = stubTransport(answer === undefined ? {} : { [FULL]: successReply(answer) });
  const context = testContext(stub.transport);
  if (offered !== null) {
    const { queryKey } = setupQuery(context.client, { mode: "start" });
    context.queryClient.setQueryData(queryKey, { data: startOf(status(offered)), diagnostics: [] });
  }
  return { stub, context };
}

function render(
  { context }: { context: RouterContext },
  initialProps: NewChatAgentInput = { waiting: null },
): RenderHookResult<NewChatAgent, NewChatAgentInput> {
  return renderHook((props: NewChatAgentInput) => useNewChatAgent(props), {
    initialProps,
    wrapper: routerWrapper(context),
  });
}

/** Runs `work`, then lets the query cache tell its observers, which it does on a later task. */
async function settled(work: () => Promise<unknown> | void): Promise<void> {
  await act(async () => {
    await work();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** The full read answers `answer` from now on, and the cache reads it again, as at a `config` event. */
async function answerAgain(
  { stub, context }: { stub: Stub; context: RouterContext },
  answer: SetupStatus,
): Promise<void> {
  stub.replies[FULL] = successReply(answer);
  await settled(() => context.queryClient.invalidateQueries({ queryKey: daemonKeys.all }));
}

function pick({ result }: RenderHookResult<NewChatAgent, NewChatAgentInput>, agent: ChatAgent): void {
  act(() => {
    result.current.pick(agent);
  });
}

describe("useNewChatAgent", () => {
  it("gives the only offered agent, sends none, and reads nothing", async () => {
    const world = daemon([CLAUDE]);

    const { result } = render(world);
    await settled(() => {});

    expect(result.current).toMatchObject({ agent: "claude", sent: undefined, choices: [], moved: null });
    expect(fullReads(world.stub)).toBe(0);
  });

  it("gives two ready agents as choices, and the default as the agent and the sent agent", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "codex"));

    const { result } = render(world);

    await waitFor(() => {
      expect(result.current).toMatchObject({ agent: "codex", sent: "codex", choices: ["claude", "codex"], moved: null });
    });
  });

  it("reads the agents when the cache has no setup entry", async () => {
    const world = daemon(null, status([CLAUDE, CODEX], "claude"));

    const { result } = render(world);

    await waitFor(() => {
      expect(result.current.agent).toBe("claude");
    });
    expect(world.stub.paths).toContain(FULL);
  });

  it("gives no agent and no choices while the read has no answer", async () => {
    const world = daemon([CLAUDE, CODEX]);
    const held = heldBack();
    world.stub.replies[FULL] = held.reply;

    const { result } = render(world);
    await settled(() => {});

    expect(result.current).toMatchObject({ agent: undefined, sent: undefined, choices: [], moved: null });
  });

  it("gives no agent and no choices for an answer with no default agent", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX]));

    const { result } = render(world);
    await waitFor(() => {
      expect(fullReads(world.stub)).toBe(1);
    });
    await settled(() => {});

    expect(result.current).toMatchObject({ agent: undefined, sent: undefined, choices: [], moved: null });
  });

  it("gives the default and no choices when only the default is ready, and sends it", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX_LOGGED_OUT], "claude"));

    const { result } = render(world);

    await waitFor(() => {
      expect(result.current).toMatchObject({ agent: "claude", sent: "claude", choices: [] });
    });
  });

  it("gives a default that is not ready, and no choices, when one other agent is ready", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX_LOGGED_OUT], "codex"));

    const { result } = render(world);

    await waitFor(() => {
      expect(result.current).toMatchObject({ agent: "codex", sent: "codex", choices: [] });
    });
  });

  it("sends no agent for an answer that lists one agent", async () => {
    const world = daemon(null, status([CLAUDE], "claude"));

    const { result } = render(world);

    await waitFor(() => {
      expect(result.current).toMatchObject({ agent: "claude", sent: undefined, choices: [] });
    });
  });

  it("changes the agent at a pick, and says nothing", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });

    pick(rendered, "codex");

    expect(rendered.result.current).toMatchObject({ agent: "codex", sent: "codex", moved: null });
  });

  it("moves a pick that a new answer leaves not ready to the default, and says why", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });
    pick(rendered, "codex");

    await answerAgain(world, status([CLAUDE, CODEX_LOGGED_OUT], "claude"));

    expect(rendered.result.current).toMatchObject({
      agent: "claude",
      choices: [],
      moved: { words: "Codex is not ready anymore. New chat uses Claude." },
    });
  });

  it("does not move back to a pick that a later answer makes ready again", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });
    pick(rendered, "codex");
    await answerAgain(world, status([CLAUDE, CODEX_LOGGED_OUT], "claude"));
    const { moved } = rendered.result.current;

    await answerAgain(world, status([CLAUDE, CODEX], "claude"));

    expect(rendered.result.current).toMatchObject({ agent: "claude", choices: ["claude", "codex"] });
    expect(rendered.result.current.moved).toBe(moved);
  });

  it("keeps a pick that stays ready when the default stops being ready, and says nothing", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });
    pick(rendered, "codex");

    await answerAgain(world, status([CLAUDE_LOGGED_OUT, CODEX], "claude"));

    expect(rendered.result.current).toMatchObject({ agent: "codex", choices: [], moved: null });
  });

  it("moves to a new default with no pick, and says the new agent", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });

    await answerAgain(world, status([CLAUDE, CODEX], "codex"));

    expect(rendered.result.current).toMatchObject({ agent: "codex", sent: "codex", moved: { words: "New chat uses Codex." } });
  });

  it("moves to a new default after a pick of the default", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });
    pick(rendered, "codex");
    pick(rendered, "claude");

    await answerAgain(world, status([CLAUDE, CODEX], "codex"));

    expect(rendered.result.current).toMatchObject({ agent: "codex", moved: { words: "New chat uses Codex." } });
  });

  it("gives no agent and says nothing for a new answer with no default agent", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });

    await answerAgain(world, status([CLAUDE, CODEX]));

    expect(rendered.result.current).toMatchObject({ agent: undefined, sent: undefined, choices: [], moved: null });
  });

  it("gives the agent of a start that waits, and keeps it as the pick after the start is refused", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });
    pick(rendered, "codex");

    rendered.rerender({ waiting: "codex" });
    expect(rendered.result.current).toMatchObject({ agent: "codex", sent: "codex", choices: ["claude", "codex"] });

    rendered.rerender({ waiting: null });
    expect(rendered.result.current).toMatchObject({ agent: "codex", sent: "codex", moved: null });
  });

  it("takes the agent of the start that waits when it mounts during the wait, also before an answer", async () => {
    const world = daemon([CLAUDE, CODEX]);
    const held = heldBack();
    world.stub.replies[FULL] = held.reply;

    const rendered = render(world, { waiting: "codex" });
    expect(rendered.result.current).toMatchObject({ agent: "codex", sent: "codex", choices: [] });

    held.answer(successReply(status([CLAUDE, CODEX], "claude")));
    await waitFor(() => {
      expect(rendered.result.current.choices).toEqual(["claude", "codex"]);
    });
    expect(rendered.result.current).toMatchObject({ agent: "codex", sent: "codex" });
    rendered.rerender({ waiting: null });

    expect(rendered.result.current).toMatchObject({ agent: "codex", sent: "codex", choices: ["claude", "codex"], moved: null });
  });

  it("keeps no pick when it mounts while a start of the default waits, so it moves to a later default", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const first = render(world);
    await waitFor(() => {
      expect(first.result.current.agent).toBe("claude");
    });
    first.unmount();
    const second = render(world, { waiting: "claude" });
    await waitFor(() => {
      expect(fullReads(world.stub)).toBe(2);
    });
    await settled(() => {});
    second.rerender({ waiting: null });

    await answerAgain(world, status([CLAUDE, CODEX], "codex"));

    expect(second.result.current).toMatchObject({ agent: "codex", sent: "codex", moved: { words: "New chat uses Codex." } });
  });

  it("says nothing when the agent changes in the render in which the wait ends", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const rendered = render(world);
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });
    pick(rendered, "codex");
    rendered.rerender({ waiting: "codex" });
    await answerAgain(world, status([CLAUDE, CODEX_LOGGED_OUT], "claude"));
    expect(rendered.result.current).toMatchObject({ agent: "codex", moved: null });

    rendered.rerender({ waiting: null });

    expect(rendered.result.current).toMatchObject({ agent: "claude", moved: null });
  });

  it("says nothing for a change of the agent while a start with no agent waits", async () => {
    const world = daemon([CLAUDE, CODEX]);
    const held = heldBack();
    world.stub.replies[FULL] = held.reply;
    const rendered = render(world, { waiting: undefined });
    expect(rendered.result.current).toMatchObject({ agent: undefined, sent: undefined });

    held.answer(successReply(status([CLAUDE, CODEX], "claude")));
    await waitFor(() => {
      expect(rendered.result.current.agent).toBe("claude");
    });
    expect(rendered.result.current).toMatchObject({ sent: "claude", moved: null });

    await answerAgain(world, status([CLAUDE, CODEX_LOGGED_OUT], "codex"));
    expect(rendered.result.current).toMatchObject({ agent: "codex", moved: null });

    await answerAgain(world, status([CLAUDE, CODEX], "claude"));
    expect(rendered.result.current).toMatchObject({ agent: "claude", moved: null });
  });

  it("reads again at each mount, and shows the last answer while the new read runs", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "codex"));
    const first = render(world);
    await waitFor(() => {
      expect(first.result.current.agent).toBe("codex");
    });
    first.unmount();
    world.stub.replies[FULL] = heldBack().reply;

    const second = render(world);

    expect(second.result.current).toMatchObject({ agent: "codex", choices: ["claude", "codex"] });
    await waitFor(() => {
      expect(fullReads(world.stub)).toBe(2);
    });
  });

  it("does not read again when the window gets the focus", async () => {
    const world = daemon([CLAUDE, CODEX], status([CLAUDE, CODEX], "claude"));
    const { result } = render(world);
    await waitFor(() => {
      expect(result.current.agent).toBe("claude");
    });

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    expect(fullReads(world.stub)).toBe(1);
  });
});
