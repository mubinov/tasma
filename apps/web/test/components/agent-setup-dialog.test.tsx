import { MutationObserver, QueryClientProvider } from "@tanstack/react-query";
import {
  createClient,
  type AgentSetup,
  type ChatAgent,
  type SetupStatus,
  type SkillInstall,
  type TransportReply,
} from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { installSkillOptions } from "../../src/api/mutations";
import { daemonKeys } from "../../src/api/queries";
import { AgentSetupDialog } from "../../src/components/agent-setup-dialog";
import { skillAgentFailure, skillInstallFailure } from "../../src/lib/write-failure";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import {
  agentEntry,
  descriptionOf,
  FULL,
  FULL_SKIPPED,
  heldBack,
  INSTALL,
  installBodies,
  nextAnswer,
  NOT_INSTALLED,
  READ_FAILED,
  refusalReply,
  routerWrapper,
  setupStatus,
  stubTransport,
  successReply,
  testContext,
} from "../helpers";

const HOLD = "The skill install is in progress. You can close this dialog after it ends.";

const REFUSED = refusalReply(500, { kind: "daemon", code: "internal", message: "the action broke" });

/** Claude is ready with its skill, and Codex has `codex` as its checks. */
function withCodex(codex: Partial<AgentSetup>): SetupStatus {
  return setupStatus({ agents: [agentEntry("claude"), agentEntry("codex", codex)] });
}

let said: string[] = [];
const originalAnnounce = useNoticeStore.getState().announce;

function trigger(name: string): HTMLElement {
  return within(dialog()).getByRole("button", { name: new RegExp(`^${name},`) });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function button(name: string): HTMLElement {
  return within(dialog()).getByRole("button", { name });
}

type Mounted = ReturnType<typeof stubTransport> & {
  queryClient: ReturnType<typeof testContext>["queryClient"];
  opener: HTMLButtonElement;
  focusFallback: ReturnType<typeof vi.fn>;
  closed: () => boolean;
};

/**
 * Mounts the dialog over a host that holds it open and owns the opener, with a full answer of `status` in the
 * cache, as the rows of the screen show only after one.
 */
function mount(
  agent: ChatAgent,
  status: SetupStatus,
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
): Mounted {
  const stub = stubTransport({ [FULL]: successReply(status), ...replies });
  const context = testContext(stub.transport);
  const Wrapper = routerWrapper(context);
  const focusFallback = vi.fn();
  // Outside the React tree, so a test can take it off the page.
  const opener = document.createElement("button");
  let open = true;

  opener.textContent = "Set up";
  document.body.append(opener);
  onTestFinished(() => {
    opener.remove();
  });
  opener.focus();
  context.queryClient.setQueryData([...daemonKeys.setup(), "full", undefined], { data: status, diagnostics: [] });

  function Host(): ReactNode {
    const [shown, setShown] = useState(true);

    return shown && (
      <AgentSetupDialog
        agent={agent}
        opener={opener}
        focusFallback={focusFallback}
        onClose={() => {
          open = false;
          setShown(false);
        }}
      />
    );
  }

  render(
    <QueryClientProvider client={context.queryClient}>
      <Wrapper><Host /></Wrapper>
    </QueryClientProvider>,
  );

  return { ...stub, queryClient: context.queryClient, opener, focusFallback, closed: () => !open };
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ skillCheckStopped: false });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  said = [];
  useNoticeStore.setState({
    notices: [],
    dismissed: new Map(),
    announce: (words) => {
      said.push(words);
    },
  });
});

afterEach(() => {
  cleanup();
  useNoticeStore.setState({ announce: originalAnnounce });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the content", () => {
  it("shows the title, the description and the three steps of Claude, with its texts", async () => {
    mount("claude", setupStatus({}, NOT_INSTALLED));

    expect(screen.getByRole("dialog", { name: "Set up Claude" })).toBeTruthy();
    expect(within(dialog()).getByText("Complete these steps. Tasma checks them again every 5 seconds.")).toBeTruthy();
    expect(within(dialog()).getByRole("list", { name: "Set up Claude" }).tagName).toBe("OL");
    expect(trigger("Install the Claude Code CLI")).toBeTruthy();
    expect(trigger("Log in to Claude Code")).toBeTruthy();
    expect(within(dialog()).getByText("Install the tasma skill in Claude Code")).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog()).getByText("Tasma runs your workflows with Claude Code.")).toBeTruthy();
    });

    const guide = within(dialog()).getByRole("link", { name: "Open the Claude Code CLI install guide" });

    expect(guide.getAttribute("href")).toBe("https://code.claude.com/docs/en/setup");
  });

  it("names its description in the dialog before the agent is set up", () => {
    mount("codex", withCodex(NOT_INSTALLED));

    expect(descriptionOf(dialog())).toBe("Complete these steps. Tasma checks them again every 5 seconds.");
  });

  it("shows the install commands of Codex and the link to its guide", async () => {
    mount("codex", withCodex(NOT_INSTALLED));

    await waitFor(() => {
      expect(within(dialog()).getByText("Tasma runs your workflows with Codex.")).toBeTruthy();
    });
    expect(within(dialog()).getByText("Run this command in a terminal:")).toBeTruthy();
    expect(within(dialog()).getByText("curl -fsSL https://chatgpt.com/codex/install.sh | sh")).toBeTruthy();
    expect(within(dialog()).getByText("Or with Homebrew:")).toBeTruthy();
    expect(within(dialog()).getByText("brew install --cask codex")).toBeTruthy();
    expect(within(dialog()).getByRole("link", { name: "Open the Codex CLI install guide" }).getAttribute("href"))
      .toBe("https://learn.chatgpt.com/docs/codex/cli");
  });

  it("shows the login command of Codex", async () => {
    mount("codex", withCodex({ loggedIn: "fail" }));

    await waitFor(() => {
      expect(within(dialog()).getByText("Chats run with your Codex account.")).toBeTruthy();
    });
    expect(within(dialog()).getByText("codex login")).toBeTruthy();
  });

  it("shows the skill step of Codex, with its own words", async () => {
    mount("codex", withCodex({ skill: "fail" }));

    await waitFor(() => {
      expect(within(dialog()).getByText("Codex needs this skill to run workflow steps.")).toBeTruthy();
    });
    expect(descriptionOf(button("Install in Codex"))).toBe(
      "If the skill is already in a different folder, Tasma cannot find it, and a second install makes Codex load two copies.",
    );
    expect(descriptionOf(button("Stop checking for the skill"))).toContain("for any agent, also after a restart.");
  });

  it("makes step 3 wait for step 2", async () => {
    mount("codex", withCodex({ loggedIn: "fail", skill: "fail" }));

    await userEvent.click(trigger("Install the tasma skill in Codex"));

    expect(within(dialog()).getByText("First, complete step 2: Log in to Codex.")).toBeTruthy();
  });
});

describe("the reads", () => {
  it("reads the full status every 5 seconds and on a window focus event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = mount("codex", withCodex(NOT_INSTALLED));
    const reads = (): number => stub.paths.filter((path) => path === FULL).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reads()).toBe(2);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(reads()).toBe(3);
  });

  it("reads with the skip flag after the check stopped", async () => {
    useUiStore.setState({ skillCheckStopped: true });
    const stub = mount("codex", withCodex(NOT_INSTALLED), { [FULL_SKIPPED]: successReply(withCodex(NOT_INSTALLED)) });

    await vi.waitFor(() => {
      expect(stub.paths).toContain(FULL_SKIPPED);
    });
  });

  it("shows and announces a failed read after a full answer one time, and removes the line after a read that succeeds", async () => {
    const stub = mount("codex", withCodex(NOT_INSTALLED));

    await nextAnswer(stub, REFUSED);
    await nextAnswer(stub, REFUSED);

    expect(within(dialog()).getByText(READ_FAILED)).toBeTruthy();
    expect(said.filter((words) => words === READ_FAILED)).toHaveLength(1);

    await nextAnswer(stub, successReply(withCodex(NOT_INSTALLED)));

    expect(within(dialog()).queryByText(READ_FAILED)).toBeNull();
  });

  it("runs Check again at once, and announces when the step still cannot be checked", async () => {
    const stub = mount("codex", withCodex({ installed: "unknown", loggedIn: "not-run" }));

    await waitFor(() => {
      expect(button("Check again")).toBeTruthy();
    });
    const before = stub.paths.filter((path) => path === FULL).length;

    await userEvent.click(button("Check again"));

    await waitFor(() => {
      expect(said).toContain("Tasma still cannot check this.");
    });
    expect(stub.paths.filter((path) => path === FULL).length).toBeGreaterThan(before);
  });

  it("starts no second read while Check again runs, and says nothing when the step can be checked", async () => {
    const held = heldBack();
    const stub = mount("codex", withCodex({ installed: "unknown", loggedIn: "not-run" }));

    stub.replies[FULL] = held.reply;
    await userEvent.click(await within(dialog()).findByRole("button", { name: "Check again" }));
    await userEvent.click(button("Check in progress"));

    expect(stub.paths.filter((path) => path === FULL)).toHaveLength(1);

    await act(async () => {
      held.answer(successReply(withCodex(NOT_INSTALLED)));
    });

    expect(said).not.toContain("Tasma still cannot check this.");
  });
});

describe("a change to done", () => {
  it("changes a step to Done after a later read, announces it and opens the next step", async () => {
    const stub = mount("codex", withCodex(NOT_INSTALLED));

    await nextAnswer(stub, successReply(withCodex({ loggedIn: "fail" })));

    expect(within(dialog()).getByText("Install the Codex CLI").closest("li")!.textContent).toContain("Done");
    expect(said).toContain("Install the Codex CLI: done.");
    expect(trigger("Log in to Codex").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows and announces that the agent is set up, and adds the line to the description of the dialog", async () => {
    const stub = mount("codex", withCodex({ skill: "fail" }));

    await nextAnswer(stub, successReply(withCodex({})));

    const line = "Codex is set up. Close this dialog to continue.";

    expect(within(dialog()).getByText(line)).toBeTruthy();
    expect(said).toContain(line);
    expect(descriptionOf(dialog())).toBe(`Complete these steps. Tasma checks them again every 5 seconds. | ${line}`);
  });

  it("counts a stopped skill check as set up, and does not announce the line when the dialog opens with it", async () => {
    useUiStore.setState({ skillCheckStopped: true });
    mount("codex", withCodex({ skill: "fail" }), { [FULL_SKIPPED]: successReply(withCodex({ skill: "not-run" })) });

    expect(within(dialog()).getByText("Codex is set up. Close this dialog to continue.")).toBeTruthy();
    expect(said).toEqual([]);
  });
});

describe("the install", () => {
  it("sends the install for its own agent only, and shows the output of Codex after a failed result", async () => {
    const result: SkillInstall = { result: "ended", agents: [{ agent: "codex", result: "failed", output: "no network" }] };
    const stub = mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: successReply(result) });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));

    expect(said).toContain("Install in progress. This can take up to 2 minutes.");
    await waitFor(() => {
      expect(within(dialog()).getByText("Tasma cannot install the skill for Codex. The command gave this output:")).toBeTruthy();
    });
    expect(installBodies(stub)).toEqual([{ agents: ["codex"] }]);
    expect(within(dialog()).getByText("no network")).toBeTruthy();
    expect(trigger("Install the tasma skill in Codex").getAttribute("aria-label")).toBe("Install the tasma skill in Codex, Cannot install");
    expect(said).toContain("Tasma cannot install the skill. The output is in step 3, above the Try again button.");
  });

  it("shows the plugin commands of Codex after npx-missing", async () => {
    mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: successReply({ result: "npx-missing" }) });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));

    await waitFor(() => {
      expect(within(dialog()).getByText("To install the skill as a Codex plugin, run these commands in a terminal:")).toBeTruthy();
    });
    expect(within(dialog()).getByText("codex plugin marketplace add mubinov/tasma-skill")).toBeTruthy();
    expect(within(dialog()).getByText("codex plugin add tasma@tasma")).toBeTruthy();
    expect(said).toContain("Tasma cannot find npx. The plugin commands are in step 3, above the Try again button.");
  });

  it("changes step 3 to Done after an install that the status read confirms", async () => {
    const stub = mount("codex", withCodex({ skill: "fail" }), {
      [INSTALL]: successReply({ result: "ended", agents: [{ agent: "codex", result: "installed" }] }),
    });

    stub.replies[FULL] = successReply(withCodex({}));
    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));

    await waitFor(() => {
      expect(said).toContain("Install the tasma skill in Codex: done.");
    });
    expect(said.some((words) => words.startsWith("Tasma cannot"))).toBe(false);
  });

  it("says no result after Stop checking for the skill during the install", async () => {
    const held = heldBack();
    mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: held.reply });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));
    await userEvent.click(button("Stop checking for the skill"));
    await act(async () => {
      held.answer(successReply({ result: "npx-missing" }));
    });

    expect(said.some((words) => words.startsWith("Tasma cannot find npx"))).toBe(false);
  });

  it("says nothing of a refused request after Stop checking for the skill during the install", async () => {
    const held = heldBack();
    mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: held.reply });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));
    await userEvent.click(button("Stop checking for the skill"));
    await act(async () => {
      held.answer(REFUSED);
    });
    await waitFor(() => {
      expect(within(dialog()).queryByText(HOLD)).toBeNull();
    });

    expect(said.some((words) => words.startsWith("Cannot install the skill"))).toBe(false);
  });

  it("shows a refused request in step 3, opens no notice, and names the block in the description of the button", async () => {
    mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: REFUSED });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));

    await waitFor(() => {
      expect(within(dialog()).getByText("Cannot install the skill")).toBeTruthy();
    });
    expect(within(dialog()).getByText("The daemon refused the request.")).toBeTruthy();
    expect(useNoticeStore.getState().notices).toEqual([]);
    expect(descriptionOf(button("Install in Codex"))).toBe(
      "Cannot install the skill | The daemon refused the request. | "
      + "If the skill is already in a different folder, Tasma cannot find it, and a second install makes Codex load two copies.",
    );
    expect(said).toContain("Cannot install the skill. The daemon refused the request.");
  });

  it("removes the failure block when the next install starts", async () => {
    const held = heldBack();
    const stub = mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: REFUSED });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));
    await within(dialog()).findByText("Cannot install the skill");
    stub.replies[INSTALL] = held.reply;
    await userEvent.click(button("Install in Codex"));

    expect(within(dialog()).queryByText("Cannot install the skill")).toBeNull();
    await act(async () => {
      held.answer(successReply({ result: "npx-missing" }));
    });
  });

  it("shows Install in progress and sends nothing while an install of another place runs", async () => {
    const held = heldBack();
    const stub = mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: held.reply });
    const client = createClient(stub.transport);
    const screenInstall = new MutationObserver(stub.queryClient, installSkillOptions(stub.queryClient, client));

    await within(dialog()).findByRole("button", { name: "Install in Codex" });
    act(() => {
      void screenInstall.mutate({
        agents: ["claude", "codex"],
        failure: skillInstallFailure("Install the skill"),
        offered: () => false,
        agentFailure: skillAgentFailure,
      });
    });

    await waitFor(() => {
      expect(trigger("Install the tasma skill in Codex").getAttribute("aria-label")).toContain("Install in progress");
    });
    expect(within(dialog()).getByText("Tasma downloads the skill from GitHub. This can take up to 4 minutes.")).toBeTruthy();

    await userEvent.click(button("Install in progress"));
    expect(installBodies(stub)).toEqual([{ agents: ["claude", "codex"] }]);

    await userEvent.click(button("Close"));
    expect(stub.closed()).toBe(true);
    await act(async () => {
      held.answer(successReply({ result: "npx-missing" }));
    });
  });
});

describe("the hold while its own install runs", () => {
  async function running() {
    const held = heldBack();
    const stub = mount("codex", withCodex({ skill: "fail" }), { [INSTALL]: held.reply });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Install in Codex" }));
    said = [];

    return { stub, held };
  }

  it("keeps the dialog open on Close, Esc and a press outside the panel, and announces the wait for each press", async () => {
    const { stub, held } = await running();

    expect(within(dialog()).getByText(HOLD)).toBeTruthy();
    expect(button("Close").getAttribute("aria-disabled")).toBe("true");

    await userEvent.click(button("Close"));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(dialog().parentElement!);

    expect(stub.closed()).toBe(false);
    expect(said).toEqual([HOLD, HOLD, HOLD]);

    await act(async () => {
      held.answer(successReply({ result: "npx-missing" }));
    });
    await waitFor(() => {
      expect(within(dialog()).queryByText(HOLD)).toBeNull();
    });
    await userEvent.click(button("Close"));

    expect(stub.closed()).toBe(true);
  });

  it("announces the wait one time for a held Esc", async () => {
    const { held } = await running();

    fireEvent.keyDown(dialog(), { key: "Escape" });
    fireEvent.keyDown(dialog(), { key: "Escape", repeat: true });

    expect(said).toEqual([HOLD]);
    await act(async () => {
      held.answer(successReply({ result: "npx-missing" }));
    });
  });

  it("ends when the request is refused", async () => {
    const { stub, held } = await running();

    await act(async () => {
      held.answer(REFUSED);
    });
    await userEvent.click(button("Close"));

    expect(stub.closed()).toBe(true);
  });
});

describe("Stop checking for the skill", () => {
  it("stores the choice for every agent, shows step 3 as not checked and announces the stop", async () => {
    mount("codex", withCodex({ skill: "fail" }), { [FULL_SKIPPED]: successReply(withCodex({ skill: "not-run" })) });

    await userEvent.click(await within(dialog()).findByRole("button", { name: "Stop checking for the skill" }));

    expect(useUiStore.getState().skillCheckStopped).toBe(true);
    expect(trigger("Install the tasma skill in Codex").getAttribute("aria-label")).toBe("Install the tasma skill in Codex, Not checked");
    expect(within(dialog()).getByText("Tasma does not check for the skill now. Codex needs the skill to run workflow steps.")).toBeTruthy();
    expect(said).toContain("Tasma does not check for the skill now, for any agent.");
  });
});

describe("focus", () => {
  it("moves to the title on open", async () => {
    mount("codex", withCodex(NOT_INSTALLED));

    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog()).getByRole("heading", { name: "Set up Codex" }));
    });
  });

  it("moves to the trigger of step 3 when the focused Copy of step 2 leaves as step 2 changes to Done", async () => {
    const stub = mount("codex", withCodex({ loggedIn: "fail", skill: "fail" }));

    const copy = await within(dialog()).findByRole("button", { name: "Copy" });

    act(() => {
      copy.focus();
    });
    await nextAnswer(stub, successReply(withCodex({ skill: "fail" })));

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger("Install the tasma skill in Codex"));
    });
  });

  it("moves to the title when the focused control leaves and no step is current", async () => {
    const stub = mount("codex", withCodex({ loggedIn: "fail", skill: "not-run" }));

    const copy = await within(dialog()).findByRole("button", { name: "Copy" });

    act(() => {
      copy.focus();
    });
    await nextAnswer(stub, successReply(withCodex({ skill: "not-run" })));

    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog()).getByRole("heading", { name: "Set up Codex" }));
    });
  });

  it("goes back to the opener on Close", async () => {
    const stub = mount("codex", withCodex(NOT_INSTALLED));

    await userEvent.click(button("Close"));

    expect(stub.closed()).toBe(true);
    await waitFor(() => {
      expect(document.activeElement).toBe(stub.opener);
    });
  });

  it("closes on Esc, and hands focus to the fallback when the opener has left the page", async () => {
    const stub = mount("codex", withCodex(NOT_INSTALLED));

    stub.opener.remove();
    await userEvent.keyboard("{Escape}");

    expect(stub.closed()).toBe(true);
    await waitFor(() => {
      expect(stub.focusFallback).toHaveBeenCalled();
    });
  });
});
