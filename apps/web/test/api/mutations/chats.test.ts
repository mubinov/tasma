import { MutationObserver, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  createClient,
  TransportError,
  type Diagnostic,
  type TransportReply,
  type TransportRequest,
} from "@tasma/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../../../src/api/client";
import {
  CHAT_CLIENT,
  chatFailureKey,
  chatRefusalCode,
  chatSeenOptions,
  chatStartKey,
  chatWriteKey,
  chatWriteOptions,
  failureKind,
  projectChatStartKey,
  projectChatStartOptions,
  usePendingChatOptions,
  usePendingProjectChatStart,
  WriteError,
  type ChatWrite,
  type StartChat,
} from "../../../src/api/mutations";
import { chatListQuery, daemonKeys, type ChatPlace } from "../../../src/api/queries";
import { projectChatStartFailure } from "../../../src/lib/write-failure";
import { chatDraft, NEW_CHAT_DRAFT, useChatDraftStore } from "../../../src/store/chat-drafts";
import { useNoticeStore } from "../../../src/store/notices";
import { useUiStore } from "../../../src/store/ui";
import { projectChatPath, projectChatRecord } from "../../chat-daemon";
import {
  chatsPath,
  pageReply,
  projectItem,
  renderDashboard,
  START_ANSWER,
  START_POST,
  stubDashboard,
  stubLayout,
} from "../../dashboard-fixtures";
import { heldBack, refusalReply, stubThreadDom, stubTransport, successReply } from "../../helpers";
import { frame } from "../../setup/notice-store";

const PLACE = { tag: "SAGA", task: "SAGA-3", chat: 2 };

const PROJECT_PLACE: ChatPlace = { tag: "SAGA", task: undefined, chat: 2 };

const CHAT_PATH = "/projects/SAGA/tasks/SAGA-3/chats/2";

const RECORD = successReply({ task: "SAGA-3", chat: 2, step: "build", agent: "claude", folder: "/work/saga", seq: 4, stateSeq: 4 });

const FAILURE = { title: "The write failed.", line: (error: WriteError) => `line of ${failureKind(error.cause)}` };

const CLOSED = { title: "The answer was not used.", line: "The request was already closed." };

const MESSAGE: ChatWrite = { kind: "message", text: "Build the app.", failure: FAILURE, restartingLine: "line of a restart" };

const CANCEL: ChatWrite = { kind: "cancel", failure: FAILURE };

const PERMISSION: ChatWrite = { kind: "permission", request: "r1", optionId: "allow-once", failure: FAILURE, closed: CLOSED };

const QUESTION: ChatWrite = {
  kind: "question",
  request: "r2",
  answer: { action: "accept", content: { question_0: "lexer" } },
  failure: FAILURE,
  closed: CLOSED,
};

const DECLINE: ChatWrite = { kind: "question", request: "r2", answer: { action: "decline" }, failure: FAILURE, closed: CLOSED };

const SAVED = { title: "Mode changed, but it is not saved.", line: "The daemon could not write the files below." };

const OPTION: ChatWrite = { kind: "option", configId: "mode", value: "auto", failure: FAILURE, saved: SAVED };

const NOT_SAVED: Diagnostic[] = [
  {
    code: "option-not-saved",
    message: "the value \"auto\" of \"mode\" is not saved as the default of claude: disk full",
    path: "/work/home/.tasma/agent-defaults.json",
  },
  { code: "option-not-saved", message: "the value \"auto\" of \"mode\" is not saved in this chat: disk full" },
];

function setup(replies: Record<string, TransportReply | Promise<TransportReply>> = {}, place: ChatPlace = PLACE) {
  const stub = stubTransport(replies);
  const queryClient = createAppQueryClient();
  const client = createClient(stub.transport);
  const observer = new MutationObserver(queryClient, chatWriteOptions(queryClient, client, place));

  return { ...stub, queryClient, client, observer };
}

function writes(requests: readonly TransportRequest[]): TransportRequest[] {
  return requests.filter(({ method }) => method !== "GET");
}

function notices() {
  return useNoticeStore.getState().notices;
}

function refused(code: "turn-running" | "already-answered" | "malformed-request"): TransportReply {
  return refusalReply(409, { kind: "daemon", code, message: `refused: ${code}` });
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

describe("CHAT_CLIENT", () => {
  it("is app- and 8 hex digits", () => {
    expect(CHAT_CLIENT).toMatch(/^app-[0-9a-f]{8}$/);
  });
});

describe("chatWriteOptions", () => {
  it.each<[string, ChatWrite, string, unknown]>([
    ["a message", MESSAGE, `${CHAT_PATH}/messages`, { text: "Build the app.", client: CHAT_CLIENT }],
    ["a cancel", CANCEL, `${CHAT_PATH}/cancel`, { client: CHAT_CLIENT }],
    ["a permission answer", PERMISSION, `${CHAT_PATH}/permissions/r1`, { optionId: "allow-once", client: CHAT_CLIENT }],
    [
      "a question answer",
      QUESTION,
      `${CHAT_PATH}/questions/r2`,
      { action: "accept", content: { question_0: "lexer" }, client: CHAT_CLIENT },
    ],
    ["a question decline", DECLINE, `${CHAT_PATH}/questions/r2`, { action: "decline", client: CHAT_CLIENT }],
    ["an option", OPTION, `${CHAT_PATH}/options`, { configId: "mode", value: "auto", client: CHAT_CLIENT }],
  ])("posts %s to its route with the client of the window", async (_name, write, path, body) => {
    const { observer, requests } = setup({ [`POST ${path}`]: RECORD });

    await observer.mutate(write);

    expect(writes(requests)).toEqual([{ method: "POST", path, body }]);
  });

  it("keys the writes under the chat", () => {
    const options = chatWriteOptions(createAppQueryClient(), createClient(stubTransport().transport), PLACE);

    expect(options.mutationKey).toEqual(chatWriteKey(PLACE));
    expect(chatWriteKey(PLACE)).toEqual(["daemon", "projects", "SAGA", "tasks", "SAGA-3", "chats", 2, "write"]);
  });

  it.each<[string, ChatWrite, string]>([
    ["a message", MESSAGE, "messages"],
    ["a cancel", CANCEL, "cancel"],
    ["a permission answer", PERMISSION, "permissions/r1"],
    ["a question answer", QUESTION, "questions/r2"],
    ["an option", OPTION, "options"],
  ])("posts %s to a chat of a project on its project route, with the body of the task route", async (_name, write, route) => {
    const task = setup({ [`POST ${CHAT_PATH}/${route}`]: RECORD });
    const project = setup({ [`POST ${projectChatPath()}/${route}`]: successReply(projectChatRecord()) }, PROJECT_PLACE);

    await task.observer.mutate(write);
    await project.observer.mutate(write);

    const sent = writes(task.requests);
    expect(sent).toHaveLength(1);
    expect(writes(project.requests)).toEqual([{ ...sent[0], path: `${projectChatPath()}/${route}` }]);
  });

  it("keys the writes of a chat of a project under the record of the chat", () => {
    const options = chatWriteOptions(createAppQueryClient(), createClient(stubTransport().transport), PROJECT_PLACE);

    expect(options.mutationKey).toEqual(chatWriteKey(PROJECT_PLACE));
    expect(chatWriteKey(PROJECT_PLACE)).toEqual(["daemon", "projects", "SAGA", "chats", 2, "write"]);
  });

  it("keys the failure notices of a chat of a project apart from those of the task chat with the same number", () => {
    expect(chatFailureKey(PLACE, "message")).toBe("chat-write-failure:SAGA/SAGA-3/2:message");
    expect(chatFailureKey(PROJECT_PLACE, "message")).toBe("chat-write-failure:SAGA/2:message");
  });

  it("opens a failure notice for a refusal, with its title, its line and the words of the daemon", async () => {
    const { observer } = setup({ [`POST ${CHAT_PATH}/messages`]: refused("turn-running") });

    await expect(observer.mutate(MESSAGE)).rejects.toBeInstanceOf(WriteError);

    expect(notices()).toEqual([
      expect.objectContaining({
        key: chatFailureKey(PLACE, "message"),
        form: "failure",
        title: "The write failed.",
        line: "line of refused",
        words: ["daemon/turn-running · refused: turn-running"],
      }),
    ]);
  });

  describe("a message refused with turn-running", () => {
    function pendingStart(queryClient: QueryClient, variables: Partial<StartChat>, status: "pending" | "success" = "pending"): void {
      queryClient.getMutationCache().build(queryClient, { mutationKey: chatStartKey() }, {
        context: undefined,
        data: undefined,
        error: null,
        failureCount: 0,
        failureReason: null,
        isPaused: false,
        status,
        variables: { tag: "SAGA", id: "SAGA-3", step: "build", from: "task", failure: FAILURE, ...variables },
        submittedAt: 1,
      });
    }

    async function lineOf(observer: ReturnType<typeof setup>["observer"]): Promise<string | undefined> {
      await expect(observer.mutate(MESSAGE)).rejects.toBeInstanceOf(WriteError);
      return notices()[0]?.line;
    }

    it("gets the line of a restart while this window restarts the task from the chat", async () => {
      const { observer, queryClient } = setup({ [`POST ${CHAT_PATH}/messages`]: refused("turn-running") });
      pendingStart(queryClient, { restart: 2 });

      expect(await lineOf(observer)).toBe("line of a restart");
    });

    it.each<[string, Partial<StartChat>, "pending" | "success"]>([
      ["a start", {}, "pending"],
      ["a restart from another chat", { restart: 1 }, "pending"],
      ["a restart of another task", { id: "SAGA-4", restart: 2 }, "pending"],
      ["a restart of a task of another project", { tag: "NOTE", restart: 2 }, "pending"],
      ["a restart that ended", { restart: 2 }, "success"],
    ])("gets the line of its failure during %s", async (_case, variables, status) => {
      const { observer, queryClient } = setup({ [`POST ${CHAT_PATH}/messages`]: refused("turn-running") });
      pendingStart(queryClient, variables, status);

      expect(await lineOf(observer)).toBe("line of refused");
    });

    it("is the only refusal that gets the line of a restart", async () => {
      const { observer, queryClient } = setup({ [`POST ${CHAT_PATH}/messages`]: refused("malformed-request") });
      pendingStart(queryClient, { restart: 2 });

      expect(await lineOf(observer)).toBe("line of refused");
    });
  });

  it("closes the failure notice of the same kind when a later write succeeds, and leaves the notice of another kind", async () => {
    const { observer, replies } = setup({
      [`POST ${CHAT_PATH}/messages`]: refused("turn-running"),
      [`POST ${CHAT_PATH}/cancel`]: refused("malformed-request"),
    });
    await expect(observer.mutate(MESSAGE)).rejects.toBeInstanceOf(WriteError);
    await expect(observer.mutate(CANCEL)).rejects.toBeInstanceOf(WriteError);
    replies[`POST ${CHAT_PATH}/messages`] = RECORD;

    await observer.mutate(MESSAGE);

    expect(notices().map(({ key }) => key)).toEqual([chatFailureKey(PLACE, "cancel")]);
  });

  it.each([PERMISSION, QUESTION])("opens a warning notice with the closed texts for already-answered", async (write) => {
    const path = write.kind === "permission" ? `${CHAT_PATH}/permissions/r1` : `${CHAT_PATH}/questions/r2`;
    const { observer } = setup({ [`POST ${path}`]: refused("already-answered") });

    const error = await observer.mutate(write).catch((caught: unknown) => caught);

    expect(chatRefusalCode(error)).toBe("already-answered");
    expect(notices()).toEqual([
      expect.objectContaining({
        key: chatFailureKey(PLACE, write.kind),
        form: "warning",
        title: "The answer was not used.",
        line: "The request was already closed.",
        words: ["daemon/already-answered · refused: already-answered"],
      }),
    ]);
  });

  it("opens a failure notice for another refusal of an answer", async () => {
    const { observer } = setup({ [`POST ${CHAT_PATH}/permissions/r1`]: refused("malformed-request") });

    await expect(observer.mutate(PERMISSION)).rejects.toBeInstanceOf(WriteError);

    expect(notices()).toEqual([expect.objectContaining({ form: "failure", title: "The write failed." })]);
  });

  it("resolves an option write with the answer, and the other writes with nothing", async () => {
    const { observer } = setup({ [`POST ${CHAT_PATH}/options`]: RECORD, [`POST ${CHAT_PATH}/messages`]: RECORD });

    await expect(observer.mutate(OPTION)).resolves.toMatchObject({ data: { seq: 4 } });
    await expect(observer.mutate(MESSAGE)).resolves.toBeUndefined();
  });

  it("opens a warning notice with the saved texts and a line for each diagnostic of an option write", async () => {
    const reply = successReply({ task: "SAGA-3", chat: 2, seq: 6 }, NOT_SAVED);
    const { observer } = setup({ [`POST ${CHAT_PATH}/options`]: reply });

    await observer.mutate(OPTION);

    expect(notices()).toEqual([
      expect.objectContaining({
        key: chatFailureKey(PLACE, "option"),
        form: "warning",
        title: "Mode changed, but it is not saved.",
        line: "The daemon could not write the files below.",
        words: [
          "/work/home/.tasma/agent-defaults.json: the value \"auto\" of \"mode\" is not saved as the default of claude: disk full",
          "the value \"auto\" of \"mode\" is not saved in this chat: disk full",
        ],
      }),
    ]);
  });

  it("closes the notice of an option write that the daemon saves", async () => {
    const { observer, replies } = setup({
      [`POST ${CHAT_PATH}/options`]: successReply({ task: "SAGA-3", chat: 2, seq: 6 }, NOT_SAVED),
    });
    await observer.mutate(OPTION);
    replies[`POST ${CHAT_PATH}/options`] = RECORD;

    await observer.mutate(OPTION);

    expect(notices()).toEqual([]);
  });

  it("opens a failure notice, not the closed warning, for an option write refused with already-answered", async () => {
    const { observer } = setup({ [`POST ${CHAT_PATH}/options`]: refused("already-answered") });

    await expect(observer.mutate(OPTION)).rejects.toBeInstanceOf(WriteError);

    expect(notices()).toEqual([
      expect.objectContaining({ key: chatFailureKey(PLACE, "option"), form: "failure", title: "The write failed." }),
    ]);
  });

  it("does not send a write again when its answer is lost", async () => {
    const lost = Promise.reject(new TransportError("POST reached no daemon"));
    lost.catch(() => {});
    const { observer, requests } = setup({ [`POST ${CHAT_PATH}/messages`]: lost });

    await expect(observer.mutate(MESSAGE)).rejects.toBeInstanceOf(WriteError);

    expect(writes(requests)).toHaveLength(1);
    expect(notices()).toEqual([expect.objectContaining({ line: "line of unanswered" })]);
  });
});

describe("chatSeenOptions", () => {
  it("keys the seen write of a chat of a project under the record of the chat", () => {
    const options = chatSeenOptions(createClient(stubTransport().transport), PROJECT_PLACE);

    expect(options.mutationKey).toEqual([...daemonKeys.projectChat("SAGA", 2), "seen"]);
  });
});

describe("usePendingChatOptions", () => {
  it("gives the pending option writes of the chat, in the order they were sent", async () => {
    const first = heldBack();
    const second = heldBack();
    const { queryClient, client } = setup({
      [`POST ${CHAT_PATH}/options`]: first.reply,
      [`POST ${CHAT_PATH}/messages`]: second.reply,
      "POST /projects/SAGA/tasks/SAGA-3/chats/3/options": second.reply,
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => usePendingChatOptions(PLACE), { wrapper });
    const other: ChatWrite = { ...OPTION, value: "default" };
    let done: Promise<unknown>[] = [];

    await act(async () => {
      done = [
        new MutationObserver(queryClient, chatWriteOptions(queryClient, client, PLACE)).mutate(OPTION),
        new MutationObserver(queryClient, chatWriteOptions(queryClient, client, PLACE)).mutate(MESSAGE),
        new MutationObserver(queryClient, chatWriteOptions(queryClient, client, { ...PLACE, chat: 3 })).mutate(OPTION),
        new MutationObserver(queryClient, chatWriteOptions(queryClient, client, PLACE)).mutate(other),
      ];
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(result.current).toEqual([OPTION, other]);

    first.answer(RECORD);
    second.answer(RECORD);
    await act(async () => {
      await Promise.all(done);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(result.current).toEqual([]);
  });
});

describe("chatRefusalCode", () => {
  it("gives the code of a refusal inside a write error, and nothing for another error", () => {
    expect(chatRefusalCode(new WriteError(new TransportError("lost")))).toBeUndefined();
    expect(chatRefusalCode(new Error("boom"))).toBeUndefined();
  });
});

describe("projectChatStartOptions", () => {
  const STARTED = "Chat 5 of SAGA started.";
  const NEW_PLACE = { tag: "SAGA", task: undefined, chat: 5 };

  function variables(text = "Plan the release") {
    return { start: { tag: "SAGA", text }, failure: projectChatStartFailure("SAGA") };
  }

  async function view(path: string, replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
    const stub = stubDashboard({ [START_POST]: START_ANSWER, ...replies });
    const router = await renderDashboard(stub, path);
    const { queryClient, client } = router.options.context;
    const options = projectChatStartOptions(queryClient, client, router);

    return { stub, router, queryClient, client, options, observer: new MutationObserver(queryClient, options) };
  }

  async function start(observer: { mutate: (write: ReturnType<typeof variables>) => Promise<unknown> }, text?: string) {
    await act(async () => {
      await observer.mutate(variables(text)).catch(() => undefined);
    });
  }

  async function spoken(): Promise<string[]> {
    await frame();
    return useNoticeStore.getState().announced.map(({ words }) => words);
  }

  beforeEach(() => {
    stubThreadDom();
    stubLayout();
    useUiStore.setState({ lastChatProject: null, startedChat: null, chatStartWatch: null, arrivalWords: null });
    useChatDraftStore.setState({ drafts: new Map() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the text as typed with the client of the window, and sends it one time", async () => {
    const { stub, options, observer } = await view("/?new=1");

    await start(observer, "  Plan the release\n");

    expect(options.retry).toBe(0);
    expect(options.mutationKey).toEqual(projectChatStartKey());
    expect(projectChatStartKey()).toEqual(["daemon", "projects", "project-chat-start"]);
    expect(stub.requests.filter(({ method }) => method === "POST")).toEqual([
      { method: "POST", path: "/projects/SAGA/chats", body: { text: "  Plan the release\n", client: CHAT_CLIENT } },
    ]);
  });

  it("says the start at Send and closes the last failure notice", async () => {
    const { reply } = heldBack();
    const { observer } = await view("/?new=1", { [START_POST]: reply });
    useNoticeStore.getState().showNotice({ key: "project-chat-start-failure", form: "failure", title: "Old", words: [] });

    act(() => {
      void observer.mutate(variables());
    });

    expect(await spoken()).toContain("Starting a chat in SAGA");
    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  it("gives the variables of the pending start", async () => {
    const { reply } = heldBack();
    const { observer, queryClient } = await view("/?new=1", { [START_POST]: reply });
    const wrapper = ({ children }: { children: ReactNode }) => (
      createElement(QueryClientProvider, { client: queryClient }, children)
    );
    const { result } = renderHook(() => usePendingProjectChatStart(), { wrapper });

    expect(result.current).toBeUndefined();
    act(() => {
      void observer.mutate(variables());
    });

    await waitFor(() => {
      expect(result.current?.start).toEqual({ tag: "SAGA", text: "Plan the release" });
    });
  });

  it("opens the chat, remembers the project and clears the view from the address", async () => {
    const { router, observer } = await view("/?new=1");

    await start(observer);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: "SAGA", chat: "5" });
    });
    expect(useUiStore.getState().lastChatProject).toBe("SAGA");
  });

  it("reads the list after the answer and before the chat opens", async () => {
    const { stub, router, observer } = await view("/?new=1");
    const reads = stub.readsOf("/chats");
    const list = heldBack();
    stub.replies["/chats"] = list.reply;

    act(() => {
      void observer.mutate(variables());
    });

    await waitFor(() => {
      expect(stub.readsOf("/chats")).toBe(reads + 1);
    });
    expect(router.state.location.search).toEqual({ new: "1" });

    await act(async () => {
      list.answer(pageReply([projectItem("SAGA", 5, 0)]));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: "SAGA", chat: "5" });
    });
  });

  it("records the time of the answer before the list reads", async () => {
    const { stub, observer } = await view("/?new=1");
    stub.replies["/chats"] = heldBack().reply;
    useUiStore.getState().setChatStartWatch({ tag: "SAGA", snapshot: new Set(), answeredAt: null });
    const before = Date.now();

    act(() => {
      void observer.mutate(variables());
    });

    await waitFor(() => {
      expect(useUiStore.getState().chatStartWatch?.answeredAt).toBeGreaterThanOrEqual(before);
    });
  });

  it("reads the list of the new filter before the chat opens, with the key that the screen reads", async () => {
    const { stub, router, queryClient, client, observer } = await view("/?new=1&project=ACME&q=%20plan%20");
    const path = chatsPath({ q: "plan" });
    const list = heldBack();
    stub.replies[path] = list.reply;

    act(() => {
      void observer.mutate(variables());
    });

    await waitFor(() => {
      expect(stub.paths).toContain(path);
    });
    expect(router.state.location.search).toMatchObject({ new: "1" });

    await act(async () => {
      list.answer(pageReply([projectItem("SAGA", 5, 0)]));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ q: " plan ", tag: "SAGA", chat: "5" });
    });
    expect(queryClient.getQueryData(chatListQuery(client, { q: "plan" }).queryKey)).toBeDefined();
  });

  it("opens the chat when the read of the new filter fails", async () => {
    const { stub, router, observer } = await view("/?new=1&project=ACME");
    stub.replies["/chats"] = refusalReply(500, { kind: "daemon", code: "internal", message: "broken" });

    await start(observer);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: "SAGA", chat: "5" });
    });
  });

  it.each([
    ["/?new=1&project=ACME", {}, `${STARTED} The project filter was cleared.`],
    ["/?new=1&q=zebra", {}, `${STARTED} The search was cleared.`],
    ["/?new=1&project=ACME&q=zebra", {}, `${STARTED} The project filter and the search were cleared.`],
    ["/?new=1&project=SAGA&q=plan", { project: "SAGA", q: "plan" }, STARTED],
    ["/?new=1&q=saga%20RELEASE", { q: "saga RELEASE" }, STARTED],
    ["/?new=1&project=GONE", {}, STARTED],
  ])("clears only the filter parts that hide the chat of %s", async (path, kept, words) => {
    const { router, observer } = await view(path);

    await start(observer);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ ...kept, tag: "SAGA", chat: "5" });
    });
    expect(useUiStore.getState().startedChat).toEqual({ tag: "SAGA", chat: 5, focus: true, words });
  });

  it("keeps the focus and says the words itself when the focus left the view", async () => {
    const { observer } = await view("/?new=1");
    document.querySelector("input")!.focus();

    await start(observer);

    expect(useUiStore.getState().startedChat).toEqual({ tag: "SAGA", chat: 5, focus: false, words: null });
    expect((await spoken()).filter((words) => words === STARTED)).toHaveLength(1);
    expect(document.activeElement).toBe(document.querySelector("input"));
  });

  describe("a chat that acts before the navigation ends", () => {
    function afterNavigation(router: Awaited<ReturnType<typeof view>>["router"], onNavigated: () => void): void {
      const navigate = router.navigate.bind(router) as (options: unknown) => Promise<void>;

      vi.spyOn(router, "navigate").mockImplementation((async (options: unknown) => {
        await navigate(options);
        onNavigated();
      }) as typeof router.navigate);
    }

    it("keeps its focus", async () => {
      const { router, observer } = await view("/?new=1");
      afterNavigation(router, () => {
        useUiStore.getState().setStartedChat(null);
        document.querySelector("input")!.focus();
      });

      await start(observer);

      expect(document.activeElement).toBe(document.querySelector("input"));
    });

    it("keeps the words that it took", async () => {
      const { router, observer } = await view("/?new=1");
      document.querySelector("input")!.focus();
      afterNavigation(router, () => {
        useUiStore.getState().takeStartedWords();
      });

      await start(observer);

      expect(await spoken()).not.toContain(STARTED);
    });
  });

  it("reads the filter with no project when the list of projects is not in the cache", async () => {
    const { router, queryClient, observer } = await view("/?new=1&project=ACME");
    queryClient.removeQueries({ queryKey: daemonKeys.projects(), exact: true });

    await start(observer);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: "SAGA", chat: "5" });
    });
    expect(useUiStore.getState().startedChat?.words).toBe(STARTED);
  });

  it("says that a chat failed to launch", async () => {
    const { observer } = await view("/?new=1", {
      [START_POST]: successReply({ chat: projectChatRecord({ chat: 5, state: "failed" }) }),
    });
    document.querySelector("input")!.focus();

    await start(observer);

    expect(await spoken()).toContain("Chat 5 of SAGA failed.");
  });

  it("moves the text typed during the wait to the draft of the new chat", async () => {
    const { reply, answer } = heldBack();
    const { observer } = await view("/?new=1", { [START_POST]: reply });

    act(() => {
      void observer.mutate(variables());
    });
    useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "One more thing");
    answer(START_ANSWER);

    await waitFor(() => {
      expect(chatDraft(NEW_PLACE)).toBe("One more thing");
    });
    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("");
  });

  it("opens nothing when the address no longer shows the view, and says the words", async () => {
    const { reply, answer } = heldBack();
    const { router, stub, observer } = await view("/?new=1", { [START_POST]: reply });

    act(() => {
      void observer.mutate(variables());
    });
    useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "One more thing");
    await act(async () => {
      await router.navigate({ to: "/", search: {} });
    });
    const reads = stub.readsOf("/chats");
    answer(START_ANSWER);

    await waitFor(() => {
      expect(stub.readsOf("/chats")).toBe(reads + 1);
    });
    await waitFor(async () => {
      expect(await spoken()).toContain(STARTED);
    });
    expect(router.state.location.search).toEqual({});
    expect(useUiStore.getState().startedChat).toBeNull();
    expect(useUiStore.getState().lastChatProject).toBe("SAGA");
    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("One more thing");
  });

  it("does not open the chat when the user leaves the view during the read of the list", async () => {
    const { stub, router, observer } = await view("/?new=1");
    const reads = stub.readsOf("/chats");
    const list = heldBack();
    stub.replies["/chats"] = list.reply;

    act(() => {
      void observer.mutate(variables());
    });
    await waitFor(() => {
      expect(stub.readsOf("/chats")).toBe(reads + 1);
    });
    await act(async () => {
      await router.navigate({ to: "/", search: {} });
    });
    await act(async () => {
      list.answer(pageReply([projectItem("SAGA", 5, 0)]));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(router.state.location.search).toEqual({});
    expect((await spoken()).filter((words) => words === STARTED)).toHaveLength(1);
  });

  it("does not open the chat in a view that the user opens again during the read of the list", async () => {
    const { stub, router, observer } = await view("/?new=1");
    const reads = stub.readsOf("/chats");
    const list = heldBack();
    stub.replies["/chats"] = list.reply;

    act(() => {
      void observer.mutate(variables());
    });
    await waitFor(() => {
      expect(stub.readsOf("/chats")).toBe(reads + 1);
    });
    await act(async () => {
      await router.navigate({ to: "/", search: { task: "ACME-7", chat: "1" } });
    });
    await act(async () => {
      await router.navigate({ to: "/", search: { new: "1" } });
    });
    useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "Another chat");
    await act(async () => {
      list.answer(pageReply([projectItem("SAGA", 5, 0)]));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(router.state.location.search).toEqual({ new: "1" });
    expect(useUiStore.getState().startedChat).toBeNull();
    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("Another chat");
    expect((await spoken()).filter((words) => words === STARTED)).toHaveLength(1);
  });

  it("puts a refused text back in front of the draft and opens the notice", async () => {
    const refusal = refusalReply(409, { kind: "daemon", code: "project-has-no-folder", message: "SAGA has no folder" });
    const { reply, answer } = heldBack();
    const { router, observer } = await view("/?new=1", { [START_POST]: reply });
    useUiStore.getState().setChatStartWatch({ tag: "SAGA", snapshot: new Set(), answeredAt: null });

    act(() => {
      void observer.mutate(variables()).catch(() => undefined);
    });
    useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "One more thing");
    answer(refusal);

    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toHaveLength(1);
    });
    expect(useNoticeStore.getState().notices[0]).toMatchObject({
      key: "project-chat-start-failure",
      form: "failure",
      title: "The new chat of SAGA did not start",
      line: "The daemon refused to start the chat. Its own words are below.",
      words: ["daemon/project-has-no-folder · SAGA has no folder"],
    });
    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("Plan the release\nOne more thing");
    expect(useUiStore.getState().chatStartWatch).toBeNull();
    expect(useUiStore.getState().lastChatProject).toBeNull();
    expect(router.state.location.search).toEqual({ new: "1" });
  });
});
