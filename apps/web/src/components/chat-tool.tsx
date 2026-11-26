import {
  useAssistantDataUI,
  useAuiState,
  type AssistantDataUIProps,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { CodeDiff } from "@kit/components/assistant-ui/elements/code-diff";
import { TerminalBlock } from "@kit/components/assistant-ui/elements/terminal-block";
import type { ThreadGroupPart } from "@kit/components/assistant-ui/elements/thread.aui";
import { TodoList, type TodoStatus } from "@kit/components/assistant-ui/elements/todo-list";
import {
  ToolFallbackArgs,
  ToolFallbackContent,
  ToolFallbackResult,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from "@kit/components/assistant-ui/elements/tool-fallback.aui";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "@kit/components/assistant-ui/elements/tool-group.aui";
import { useRef, useState, type PropsWithChildren, type ReactNode, type RefObject } from "react";
import type { ChatRequest } from "../lib/chat-approval";
import type { ChatNotice, ChatPlanEntry, ChatQuestion, ChatTool, ChatToolContent } from "../lib/chat-fold";
import {
  chatDiff,
  chatNoticeText,
  chatRequestEnd,
  chatTerminalView,
  chatToolArgsText,
  chatToolName,
  chatToolResult,
  chatToolStatus,
  chatToolWaits,
  type ChatTerminalView,
  type ChatToolArtifact,
} from "../lib/chat-messages";
import { WarningIcon } from "../lib/icons";
import { focusInView } from "../lib/focus-in-view";
import { useFocusLost } from "../lib/use-focus-lost";

const PLAN_STATUSES: Record<ChatPlanEntry["status"], TodoStatus> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
};

const LINE_CLASS = "flex flex-col gap-1 text-sm wrap-anywhere";

type DiffContent = Extract<ChatToolContent, { type: "diff" }>;

/** What the body of a tool view shows: its diffs, else its terminal, else its arguments and its result. */
type ToolBody = { kind: "diff"; diffs: DiffContent[] } | ChatTerminalView | { kind: "fallback" };

/** Each tool part of a chat carries its tool, which `chatThreadMessage` puts in the artifact. */
function toolOf(artifact: unknown): ChatTool {
  return (artifact as ChatToolArtifact).tool;
}

function toolBody(tool: ChatTool): ToolBody {
  const diffs = tool.content.filter((item) => item.type === "diff");
  const terminal = tool.content.find((item) => item.type === "terminal");

  if (diffs.length > 0) {
    return { kind: "diff", diffs };
  }
  return terminal === undefined ? { kind: "fallback" } : chatTerminalView(tool, terminal.terminal);
}

/**
 * The tool view, and under it the line of its request. Every body has the
 * same trigger, so a change of the body keeps focus on the trigger.
 */
export const ChatToolView: ToolCallMessagePartComponent = ({ artifact }) => {
  const { tool, folder } = artifact as ChatToolArtifact;
  const status = chatToolStatus(tool);
  const bodyKind = toolBody(tool).kind;
  // A diff and a terminal show open; any other tool opens while it waits for an answer.
  const opensItself = bodyKind !== "fallback" || status.type === "requires-action";
  const [open, setOpen] = useState(opensItself);
  const [openedItself, setOpenedItself] = useState(opensItself);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (opensItself !== openedItself) {
    setOpenedItself(opensItself);
    if (opensItself) {
      setOpen(true);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <ToolFallbackRoot open={open} onOpenChange={setOpen}>
        <ToolFallbackTrigger ref={triggerRef} toolName={chatToolName(tool)} status={status} />
        <ToolFallbackContent>
          <ToolBodyView key={bodyKind} triggerRef={triggerRef}>
            <ChatToolBody tool={tool} folder={folder} />
          </ToolBodyView>
        </ToolFallbackContent>
      </ToolFallbackRoot>
      {tool.permission !== undefined && <RequestView request={{ kind: "permission", permission: tool.permission }} className="ps-6" />}
      {tool.question !== undefined && <RequestView request={{ kind: "question", question: tool.question }} className="ps-6" />}
    </div>
  );
};

/** The line of a request. The request panel above the composer answers the request while it is open. */
function RequestView({ request, className }: { request: ChatRequest; className: string }): ReactNode {
  const end = chatRequestEnd(request);
  const waiting = request.kind === "permission" ? "Waiting for your permission below." : "Waiting for your answer below.";

  return (
    <div className={`${LINE_CLASS} ${className}`}>
      {request.kind === "question" && <p>{request.question.message}</p>}
      {end === undefined ? <p className="text-signal">{waiting}</p> : <p>{end}</p>}
    </div>
  );
}

/** When a body of another kind replaces it with focus inside, focus moves to the trigger of the tool. */
function ToolBodyView(
  { triggerRef, children }: PropsWithChildren<{ triggerRef: RefObject<HTMLButtonElement | null> }>,
): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useFocusLost(ref, () => {
    focusInView(triggerRef.current);
  });

  return <div ref={ref} className="flex flex-col gap-2">{children}</div>;
}

/** The kit shows an empty string as an empty result box. */
function shownResult(result: unknown): unknown {
  return result === "" ? undefined : result;
}

export function ChatToolBody({ tool, folder }: ChatToolArtifact): ReactNode {
  const body = toolBody(tool);
  const { type } = chatToolStatus(tool);
  const noOutput = type === "complete" || type === "incomplete" ? <p className="text-sm text-subtle">No output.</p> : null;

  switch (body.kind) {
    case "diff":
      return body.diffs.map((diff, index) => (
        // A tool can change one file twice.
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <CodeDiff key={index} {...chatDiff(diff, folder)} cycle={0} />
      ));
    case "block":
      return (
        <TerminalBlock
          command={body.command}
          lines={body.lines}
          visibleCount={body.lines.length}
          done={body.done}
          exitCode={body.exitCode}
          maxCollapsedLines={12}
        />
      );
    case "result": {
      const output = shownResult(body.output);
      return output === undefined ? noOutput : <ToolFallbackResult result={output} />;
    }
    case "fallback": {
      const argsText = chatToolArgsText(tool);
      const shown = shownResult(chatToolResult(tool));
      if (argsText === "" && shown === undefined) {
        return noOutput;
      }
      return (
        <>
          <ToolFallbackArgs argsText={argsText} />
          <ToolFallbackResult result={shown} />
        </>
      );
    }
  }
}

/**
 * Opens by itself when one of its tools gets a request that waits for an
 * answer, and starts open while one does; the reader can close it again.
 */
export function ChatToolGroup({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>): ReactNode {
  const waiting = useAuiState((state) =>
    group.indices.some((index) => {
      const part = state.message.parts[index];
      return part?.type === "tool-call" && chatToolWaits(toolOf(part.artifact));
    }));
  const [open, setOpen] = useState(waiting);
  const [wasWaiting, setWasWaiting] = useState(waiting);

  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    if (waiting) {
      setOpen(true);
    }
  }

  return (
    <ToolGroupRoot variant="ghost" open={open} onOpenChange={setOpen}>
      <ToolGroupTrigger count={group.indices.length} active={group.status.type === "running"} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}

export function ChatEmpty(): ReactNode {
  return <p className="text-sm text-subtle">This chat has no messages yet.</p>;
}

/** The data of a part is what `chatThreadMessage` put under its name. */
type DataProps = { data: unknown };

function PlanView({ data }: DataProps): ReactNode {
  const items = (data as readonly ChatPlanEntry[]).map((entry, index) => ({
    id: String(index),
    text: entry.content,
    status: PLAN_STATUSES[entry.status],
  }));
  return <TodoList title="Plan" items={items} className="my-2" />;
}

function NoticeView({ data }: DataProps): ReactNode {
  const notice = data as ChatNotice;
  if (notice.kind === "failed") {
    return (
      <p className="my-2 flex items-start gap-1.5 text-sm text-signal">
        <WarningIcon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0 wrap-anywhere">{chatNoticeText(notice)}</span>
      </p>
    );
  }
  return <p className="my-2 text-sm text-subtle wrap-anywhere">{chatNoticeText(notice)}</p>;
}

/** A question with no tool. */
function QuestionView({ data }: DataProps): ReactNode {
  return <RequestView request={{ kind: "question", question: data as ChatQuestion }} className="my-2" />;
}

const PLAN_UI: AssistantDataUIProps = { name: "plan", render: PlanView };

const NOTICE_UI: AssistantDataUIProps = { name: "notice", render: NoticeView };

const QUESTION_UI: AssistantDataUIProps = { name: "question", render: QuestionView };

/** Registers the views of the data parts of a chat while it is mounted. */
export function ChatDataViews(): null {
  useAssistantDataUI(PLAN_UI);
  useAssistantDataUI(NOTICE_UI);
  useAssistantDataUI(QUESTION_UI);
  return null;
}
