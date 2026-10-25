import {
  useAssistantDataUI,
  useAuiState,
  type AssistantDataUIProps,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import { CodeDiff } from "@kit/components/assistant-ui/elements/code-diff";
import { TerminalBlock } from "@kit/components/assistant-ui/elements/terminal-block";
import type { ThreadGroupPart } from "@kit/components/assistant-ui/elements/thread.aui";
import { TodoList, type TodoStatus } from "@kit/components/assistant-ui/elements/todo-list";
import {
  ToolFallbackApproval,
  ToolFallbackArgs,
  ToolFallbackContent,
  ToolFallbackResult,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from "@kit/components/assistant-ui/elements/tool-fallback.aui";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "@kit/components/assistant-ui/elements/tool-group.aui";
import { useId, useRef, useState, type PropsWithChildren, type ReactNode, type RefObject } from "react";
import type { ChatPlace } from "../api/queries";
import { questionApproval, questionResponse, type ChatApproval, type ChatRequest } from "../lib/chat-approval";
import type { ChatNotice, ChatPermission, ChatPlanEntry, ChatQuestion, ChatTool, ChatToolContent } from "../lib/chat-fold";
import {
  chatAnswerText,
  chatDiff,
  chatNoticeText,
  chatTerminalView,
  chatToolName,
  chatToolStatus,
  chatToolWaits,
  REQUIRES_ACTION,
  type ChatTerminalView,
  type ChatToolArtifact,
} from "../lib/chat-messages";
import { WarningIcon } from "../lib/icons";
import { focusInView } from "../lib/focus-in-view";
import { useChatWrites } from "../lib/use-chat-writes";
import { useFocusLost } from "../lib/use-focus-lost";

const PLAN_STATUSES: Record<ChatPlanEntry["status"], TodoStatus> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
};

const WAITING_CLASS = "text-signal";

const LINE_CLASS = "flex flex-col gap-1 text-sm wrap-anywhere";

type DiffContent = Extract<ChatToolContent, { type: "diff" }>;

type RespondToApproval = ToolCallMessagePartProps["respondToApproval"];

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
export const ChatToolView: ToolCallMessagePartComponent = ({
  argsText,
  result,
  artifact,
  approval,
  respondToApproval,
}) => {
  const { tool, folder } = artifact as ChatToolArtifact;
  const status = chatToolStatus(tool);
  const body = toolBody(tool);
  // A diff and a terminal show open; any other tool opens while it waits for an answer.
  const opensItself = body.kind !== "fallback" || status.type === "requires-action";
  const [open, setOpen] = useState(opensItself);
  const [openedItself, setOpenedItself] = useState(opensItself);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  // The kit tool group clips at its right and bottom edges, so the end padding keeps the focus ring of the line whole.
  const requestProps = { approval, respondToApproval, status, triggerId, className: "flex flex-col gap-1 ps-6 pe-1 pb-1" };

  if (opensItself !== openedItself) {
    setOpenedItself(opensItself);
    if (opensItself) {
      setOpen(true);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <ToolFallbackRoot open={open} onOpenChange={setOpen}>
        <ToolFallbackTrigger ref={triggerRef} id={triggerId} toolName={chatToolName(tool)} status={status} />
        <ToolFallbackContent>
          <ToolBodyView key={body.kind} triggerRef={triggerRef}>
            <ToolBodyContent body={body} folder={folder} argsText={argsText} result={result as unknown} />
          </ToolBodyView>
        </ToolFallbackContent>
      </ToolFallbackRoot>
      {tool.permission !== undefined && <RequestView request={{ kind: "permission", permission: tool.permission }} {...requestProps} />}
      {tool.question !== undefined && <RequestView request={{ kind: "question", question: tool.question }} {...requestProps} />}
    </div>
  );
};

type RequestViewProps = {
  request: ChatRequest;
  /** The approval of the open request of the part. The view shows it only when it is the approval of this request. */
  approval: ChatApproval | undefined;
  respondToApproval: RespondToApproval;
  status: ToolCallMessagePartStatus;
  /** The trigger of the tool of the request. A question with no tool has none. */
  triggerId?: string;
  className: string;
};

/** The line of a request, and under it the kit view that answers the request while it is open. */
function RequestView(
  { request, approval, respondToApproval, status, triggerId, className }: RequestViewProps,
): ReactNode {
  const lineRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const ruleId = useId();
  const id = request.kind === "permission" ? request.permission.request : request.question.request;
  const openApproval = approval?.id === id ? approval : undefined;
  // Only the kit form of a question with fields has a rule line. It is in the name of the group, because a
  // screen reader does not read the description of a group.
  const formRuleId = openApproval?.display === "questions" ? ruleId : undefined;
  const labelledBy = [triggerId, labelId, formRuleId].filter((part) => part !== undefined).join(" ");

  return (
    <div className={className}>
      {request.kind === "permission"
        ? <PermissionLine ref={lineRef} labelId={labelId} permission={request.permission} />
        : <QuestionLine ref={lineRef} labelId={labelId} ruleId={formRuleId} question={request.question} />}
      {openApproval !== undefined && (
        <RequestAnswer
          approval={openApproval}
          respondToApproval={respondToApproval}
          status={status}
          labelledBy={labelledBy}
          lineRef={lineRef}
        />
      )}
    </div>
  );
}

type RequestAnswerProps = {
  approval: ChatApproval;
  respondToApproval: RespondToApproval;
  status: ToolCallMessagePartStatus;
  /** The ids of the visible label of the group. */
  labelledBy: string;
  /** The line of the request, which shows its outcome after it closes. */
  lineRef: RefObject<HTMLDivElement | null>;
};

/**
 * The kit view that answers an open request. It leaves the page when the
 * request closes, and focus inside it moves to the line.
 */
function RequestAnswer({ approval, respondToApproval, status, labelledBy, lineRef }: RequestAnswerProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useFocusLost(ref, () => {
    focusInView(lineRef.current);
  });

  return (
    <div ref={ref} role="group" aria-labelledby={labelledBy}>
      <ToolFallbackApproval approval={approval} respondToApproval={respondToApproval} status={status} />
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

/** The line of a request takes focus when the kit view under it leaves the page. */
type LineProps = { ref: RefObject<HTMLDivElement | null>; labelId: string };

function permissionEnd(permission: ChatPermission): string | undefined {
  switch (permission.state) {
    case "open":
      return undefined;
    case "selected": {
      const chosen = permission.options.find((option) => option.id === permission.option)?.name ?? permission.option;
      return chosen === undefined ? "Answered." : `Answered: ${chosen}.`;
    }
    case "cancelled":
      return "The request was cancelled.";
    case "ended":
      return "The request ended with no answer.";
  }
}

/** While the request is open, the kit buttons under the line show its options. */
function PermissionLine({ permission, ref, labelId }: LineProps & { permission: ChatPermission }): ReactNode {
  const end = permissionEnd(permission);

  return (
    <div ref={ref} id={labelId} tabIndex={-1} className={LINE_CLASS}>
      {end === undefined ? <p className={WAITING_CLASS}>Waiting for your permission.</p> : <p>{end}</p>}
    </div>
  );
}

function questionEnd(question: ChatQuestion): string | undefined {
  switch (question.state) {
    case "accepted": {
      const answer = chatAnswerText(question.answer);
      return answer === "" ? "Answered." : `Answered: ${answer}.`;
    }
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

type QuestionLineProps = LineProps & {
  question: ChatQuestion;
  /** The id of the rule line, which shows only while the kit form shows. */
  ruleId: string | undefined;
};

/** While the question is open, the kit view under the line answers it. `labelId` names the message. */
function QuestionLine({ question, ref, labelId, ruleId }: QuestionLineProps): ReactNode {
  const end = questionEnd(question);

  return (
    <div ref={ref} tabIndex={-1} className={LINE_CLASS}>
      <p id={labelId}>{question.message}</p>
      {end === undefined
        ? (
            <>
              <p className={WAITING_CLASS}>Waiting for your answer.</p>
              {/* The kit form enables Send only when each question has an answer, also an optional one. */}
              {ruleId !== undefined && (
                <p id={ruleId}>Answer each question, then press Send. Dismiss declines the question.</p>
              )}
            </>
          )
        : <p>{end}</p>}
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

/**
 * A question with no tool. The thread has no method that answers a data part,
 * so the view sends its answer itself.
 */
function QuestionView({ data, place }: DataProps & { place: ChatPlace }): ReactNode {
  const question = data as ChatQuestion;
  const request: ChatRequest = { kind: "question", question };
  const writes = useChatWrites(place);

  return (
    <RequestView
      request={request}
      approval={question.state === "open" ? questionApproval(question) : undefined}
      respondToApproval={(response) => writes.answer(request, questionResponse(question.request, response))}
      status={REQUIRES_ACTION}
      className="my-2 flex flex-col gap-1"
    />
  );
}

const PLAN_UI: AssistantDataUIProps = { name: "plan", render: PlanView };

const NOTICE_UI: AssistantDataUIProps = { name: "notice", render: NoticeView };

function questionUI(place: ChatPlace): AssistantDataUIProps {
  return { name: "question", render: ({ data }: DataProps) => <QuestionView data={data} place={place} /> };
}

/** Registers the views of the data parts of a chat while it is mounted. The host keys it by its chat. */
export function ChatDataViews(place: ChatPlace): null {
  // Made once: a new `render` registers the view again, and the thread remounts each question form with it.
  const [questionView] = useState(() => questionUI(place));

  useAssistantDataUI(PLAN_UI);
  useAssistantDataUI(NOTICE_UI);
  useAssistantDataUI(questionView);
  return null;
}
