import { useAuiState, useThreadViewport } from "@assistant-ui/react";
import { ToolFallbackApproval } from "@kit/components/assistant-ui/elements/tool-fallback.aui";
import type { ChatAgent } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatPlace } from "../api/queries";
import {
  chatRequestId,
  permissionApproval,
  questionApproval,
  requestResponse,
  type ChatRequestItem,
} from "../lib/chat-approval";
import { chatAgentName, chatToolName, REQUIRES_ACTION } from "../lib/chat-messages";
import { focusInView, KIT_INPUT } from "../lib/focus-in-view";
import { QuestionIcon, ShieldIcon } from "../lib/icons";
import { useChatWrites } from "../lib/use-chat-writes";
import { focusDropped, useFocusLost } from "../lib/use-focus-lost";
import { useOverflows } from "../lib/use-overflows";
import { useNoticeStore } from "../store/notices";
import { ChatToolBody } from "./chat-tool";

/** How long the controls of a request that shows after the panel mounted stay disabled. */
const SETTLE_MS = 500;

/** What the request panel gets through the runtime extras. */
export type RequestPanelInput = {
  agent: ChatAgent;
  place: ChatPlace;
  /** The folder of the chat, against which a tool body shows its paths. */
  folder: string;
  /** From `chatOpenRequests`. The panel shows the first. */
  items: readonly ChatRequestItem[];
  /** What became of a request in the current view. */
  resultOf: (id: string) => string | undefined;
};

function hasRequests(extras: unknown): extras is { requests: RequestPanelInput } {
  return typeof extras === "object" && extras !== null && "requests" in extras;
}

/** The oldest open request of the chat, fixed above the composer, where the user answers it. */
export function ChatRequestPanel(): ReactNode {
  const extras = useAuiState((s) => s.thread.extras);

  return hasRequests(extras) && <RequestPanel {...extras.requests} />;
}

/**
 * Stays mounted while no request is open, so it sees the section of the
 * request that it showed leave the page.
 */
function RequestPanel({ agent, place, folder, items, resultOf }: RequestPanelInput): ReactNode {
  const shown = items[0];
  const shownId = shown === undefined ? undefined : chatRequestId(shown);
  const viewport = useThreadViewport((s) => s.element.viewport);
  const groupRef = useRef<HTMLDivElement>(null);
  // The id of the request whose section left the page with focus inside.
  const lostRef = useRef<string | null>(null);
  const [previousId, setPreviousId] = useState(shownId);
  // A new request covers what was under the pointer: the log, or the request that just closed.
  const [settling, setSettling] = useState(false);
  const afterSectionLeft = useEffectEvent((id: string) => {
    const words = resultOf(id);
    // A request that the agent asks again goes to the end of the list, still open.
    if (words !== undefined) {
      useNoticeStore.getState().announce(words);
    }
    // The group, not its first control, which answers the request.
    focusInView(groupRef.current ?? viewport!.querySelector<HTMLElement>(KIT_INPUT));
  });

  if (shownId !== previousId) {
    setPreviousId(shownId);
    if (shownId !== undefined) {
      setSettling(true);
    }
  }

  useEffect(() => {
    if (!settling) {
      return;
    }
    const timer = setTimeout(() => {
      setSettling(false);
    }, SETTLE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [settling, shownId]);

  // Here, not in the cleanup of the section: the section holds the old view, in which the request is still open.
  // StrictMode runs the cleanup of a new section again after the focus moved into it, so the focus must have dropped.
  useLayoutEffect(() => {
    const id = lostRef.current;
    lostRef.current = null;
    if (id !== null && focusDropped()) {
      afterSectionLeft(id);
    }
  }, [shownId]);

  return shown !== undefined && (
    <RequestSection
      key={shownId}
      agent={agent}
      place={place}
      folder={folder}
      request={shown}
      count={items.length}
      settling={settling}
      groupRef={groupRef}
      onFocusLost={(id) => {
        lostRef.current = id;
      }}
    />
  );
}

type RequestSectionProps = {
  agent: ChatAgent;
  place: ChatPlace;
  folder: string;
  request: ChatRequestItem;
  /** The number of open requests. */
  count: number;
  /** The controls are disabled. */
  settling: boolean;
  groupRef: RefObject<HTMLDivElement | null>;
  /** Gets the id of the request whose section left the page with focus inside. */
  onFocusLost: (id: string) => void;
};

/** Keyed by its request, so a new request starts with an empty form. */
function RequestSection(
  { agent, place, folder, request, count, settling, groupRef, onFocusLost }: RequestSectionProps,
): ReactNode {
  const id = chatRequestId(request);
  const writes = useChatWrites(place);
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overflows = useOverflows(bodyRef);
  const titleId = useId();
  const countId = useId();
  const messageId = useId();
  const ruleId = useId();
  const toolId = useId();
  const name = chatAgentName(agent);
  const approval = request.kind === "permission" ? permissionApproval(request.permission) : questionApproval(request.question);
  const ruled = approval.display === "questions";
  const Icon = request.kind === "permission" ? ShieldIcon : QuestionIcon;
  // A screen reader does not read the description of a group, so the rule line is in its name.
  const formLabel = request.kind === "permission" ? `${titleId} ${toolId}` : ruled ? `${messageId} ${ruleId}` : messageId;

  useFocusLost(sectionRef, () => {
    onFocusLost(id);
  });

  return (
    <section
      ref={sectionRef}
      aria-labelledby={count > 1 ? `${titleId} ${countId}` : titleId}
      className="flex max-h-[50cqh] min-h-[min(8rem,50cqh)] w-full max-w-(--thread-max-width) animate-enter flex-col overflow-hidden rounded-panel border border-l-3 border-line border-l-signal bg-surface"
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Icon size={16} aria-hidden="true" className="shrink-0 text-signal" />
        <span id={titleId} className="font-chrome text-sm font-semibold">
          {request.kind === "permission" ? `${name} asks for permission` : `${name} asks a question`}
        </span>
        {count > 1 && <span id={countId} className="text-xs text-subtle">{`1 of ${String(count)}`}</span>}
      </div>
      {/* A scroll container is a tab stop only in some engines, so the body is one while it scrolls. */}
      <div
        ref={bodyRef}
        role="group"
        aria-labelledby={titleId}
        tabIndex={overflows ? 0 : -1}
        className="min-h-0 overflow-y-auto px-4 pb-3 focus-visible:-outline-offset-2"
      >
        {/* `useOverflows` observes only the children at its mount, so one stable child wraps the content. */}
        <div className="flex flex-col gap-2">
          {request.kind === "permission"
            ? (
                <>
                  <p id={toolId} className="font-mono text-sm wrap-anywhere">{chatToolName(request.tool)}</p>
                  <ChatToolBody tool={request.tool} folder={folder} />
                </>
              )
            : (
                <>
                  <p id={messageId} className="wrap-anywhere">{request.question.message}</p>
                  {/* The kit form enables Send only when each question has an answer, also an optional one. */}
                  {ruled && <p id={ruleId}>Answer each question, then press Send. Dismiss declines the question.</p>}
                </>
              )}
          <div ref={groupRef} role="group" tabIndex={-1} aria-labelledby={formLabel}>
            {/* The fieldset disables the kit controls and leaves the group around it focusable. The kit buttons do not
                wrap by themselves, and a long option, for example a command prefix, would go past the panel. */}
            <fieldset
              role="none"
              disabled={settling}
              className="min-w-0 [&_button]:h-auto [&_button]:min-h-7 [&_button]:max-w-full [&_button]:text-start [&_button]:whitespace-normal [&_button]:wrap-anywhere"
            >
              <ToolFallbackApproval
                approval={approval}
                respondToApproval={(response) => writes.answer(request, requestResponse(request, response))}
                status={REQUIRES_ACTION}
              />
            </fieldset>
          </div>
        </div>
      </div>
    </section>
  );
}
