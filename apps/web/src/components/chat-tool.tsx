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
import type {
  ChatNotice,
  ChatPermission,
  ChatPlanEntry,
  ChatQuestion,
  ChatQuestionField,
  ChatTool,
  ChatToolContent,
} from "../lib/chat-fold";
import {
  chatAnswerText,
  chatDiff,
  chatNoticeText,
  chatTerminalView,
  chatToolName,
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

const WAITING_CLASS = "text-signal";

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
export const ChatToolView: ToolCallMessagePartComponent = ({ argsText, result, artifact }) => {
  const { tool, folder } = artifact as ChatToolArtifact;
  const status = chatToolStatus(tool);
  const body = toolBody(tool);
  // A diff and a terminal show open; any other tool opens while it waits for an answer.
  const opensItself = body.kind !== "fallback" || status.type === "requires-action";
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
          <ToolBodyView key={body.kind} triggerRef={triggerRef}>
            <ToolBodyContent body={body} folder={folder} argsText={argsText} result={result as unknown} />
          </ToolBodyView>
        </ToolFallbackContent>
      </ToolFallbackRoot>
      {tool.permission !== undefined && <div className="ps-6"><PermissionLine permission={tool.permission} /></div>}
      {tool.question !== undefined && <div className="ps-6"><QuestionLine question={tool.question} /></div>}
    </div>
  );
};

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

type ToolBodyContentProps = { body: ToolBody; folder: string; argsText: string; result: unknown };

function ToolBodyContent({ body, folder, argsText, result }: ToolBodyContentProps): ReactNode {
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
    case "result":
      return <ToolFallbackResult result={body.output} />;
    case "fallback":
      return (
        <>
          <ToolFallbackArgs argsText={argsText} />
          <ToolFallbackResult result={result} />
        </>
      );
  }
}

function PermissionLine({ permission }: { permission: ChatPermission }): ReactNode {
  switch (permission.state) {
    case "open":
      return (
        <div className={LINE_CLASS}>
          <p className={WAITING_CLASS}>Waiting for your permission.</p>
          {permission.options.length > 0 && (
            <p>{`Options: ${permission.options.map((option) => option.name).join(", ")}.`}</p>
          )}
        </div>
      );
    case "selected": {
      const chosen = permission.options.find((option) => option.id === permission.option)?.name ?? permission.option;
      return <p className={LINE_CLASS}>{chosen === undefined ? "Answered." : `Answered: ${chosen}.`}</p>;
    }
    case "cancelled":
      return <p className={LINE_CLASS}>The request was cancelled.</p>;
    case "ended":
      return <p className={LINE_CLASS}>The request ended with no answer.</p>;
  }
}

function questionEnd(question: ChatQuestion): string | undefined {
  switch (question.state) {
    case "accepted":
      return `Answered: ${chatAnswerText(question.answer)}.`;
    case "declined":
      return "Declined.";
    case "cancelled":
      return "The question was cancelled.";
    case "ended":
      return "The question ended with no answer.";
    default:
      return undefined;
  }
}

function QuestionLine({ question }: { question: ChatQuestion }): ReactNode {
  const end = questionEnd(question);

  return (
    <div className={LINE_CLASS}>
      <p>{question.message}</p>
      {end === undefined
        ? (
            <>
              {question.fields.map((field) => <QuestionField key={field.name} field={field} />)}
              <p className={WAITING_CLASS}>Waiting for your answer.</p>
            </>
          )
        : <p>{end}</p>}
    </div>
  );
}

function QuestionField({ field }: { field: ChatQuestionField }): ReactNode {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="font-medium">{field.title ?? field.name}</p>
      {field.description !== undefined && <p className="text-subtle">{field.description}</p>}
      {field.choices.length > 0 && (
        <ul className="list-disc ps-5">
          {field.choices.map((choice) => (
            <li key={choice.value}>
              {choice.label}
              {choice.description !== undefined && <span className="text-subtle">{` — ${choice.description}`}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

function QuestionView({ data }: DataProps): ReactNode {
  return <div className="my-2"><QuestionLine question={data as ChatQuestion} /></div>;
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
