import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { openRestartSkipped } from "../api/mutations";
import { taskChatsQuery, taskQuery, workflowQuery } from "../api/queries";
import type { FinalFocus } from "../lib/final-focus";
import { actionStep, stepAction } from "../lib/step-action";
import { chatRestartSkippedNotice } from "../lib/write-failure";
import { useNoticeStore } from "../store/notices";
import { ConfirmDialog } from "./confirm-dialog";

type RestartDialogProps = {
  open: boolean;
  tag: string;
  id: string;
  step: string;
  /** The chat that the restart replaces. */
  chat: number;
  /** Also runs when the dialog closes itself because the chat is no longer the chat of its step. */
  onCancel: () => void;
  /** Runs once for each open of the dialog. */
  onConfirm: () => void;
  finalFocus: RefObject<FinalFocus>;
};

/**
 * The read landed after the mount. Not `isFetching`: a read of it renders the
 * dialog at the start of a fetch, and a fast answer then reaches the dialog one
 * commit before the page.
 */
function landed({ isSuccess, isFetchedAfterMount }: { isSuccess: boolean; isFetchedAfterMount: boolean }): boolean {
  return isSuccess && isFetchedAfterMount;
}

function RestartDialogBody(
  { open, tag, id, step, chat, onCancel, onConfirm, finalFocus }: RestartDialogProps,
): ReactNode {
  const { client, queryClient } = useRouter().options.context;
  // The cache can hold a read from before a step change: a feed event only marks a read that nothing observes.
  const readOptions = { enabled: open, staleTime: 0 };
  const taskRead = useQuery({ ...taskQuery(client, tag, id), ...readOptions }, queryClient);
  const frontmatter = taskRead.data?.data.frontmatter;
  const workflowName = frontmatter?.workflow;
  const workflowRead = useQuery(
    { ...workflowQuery(client, workflowName ?? ""), ...readOptions, enabled: open && workflowName !== undefined },
    queryClient,
  );
  const chatsRead = useQuery({ ...taskChatsQuery(client, tag, id), ...readOptions }, queryClient);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const sentRef = useRef(false);
  const skippedRef = useRef(false);
  const chats = chatsRead.data?.data;
  const working = chats?.find((candidate) => candidate.chat === chat)?.state === "working";
  const lastRef = useRef({ open, working });
  const loaded = landed(taskRead) && landed(chatsRead) && (workflowName === undefined || landed(workflowRead));
  let stale = false;

  if (loaded) {
    const stepNow = actionStep(frontmatter!, workflowRead.data?.data);
    const action = stepNow === null ? null : stepAction(stepNow, chats!);
    stale = action?.kind !== "open" || action.chat !== chat;
  }

  // The warning waits for the commit of the close: a notice store update renders before a state update of an effect.
  const skip = useEffectEvent(() => {
    if (open && stale) {
      skippedRef.current = true;
      onCancel();
    } else if (!open && skippedRef.current) {
      skippedRef.current = false;
      openRestartSkipped(id, chatRestartSkippedNotice(id, chat));
    }
  });

  useEffect(() => {
    skip();
  }, [open, stale]);

  // A confirm under the focus must not change its meaning unheard.
  useLayoutEffect(() => {
    const last = lastRef.current;
    lastRef.current = { open, working };
    if (!open || !last.open || !working || last.working) {
      return;
    }
    useNoticeStore.getState().announce(`The agent in chat ${String(chat)} is working now.`);
    if (document.activeElement === confirmRef.current) {
      cancelRef.current?.focus();
    }
  }, [open, working, chat]);

  const words = working
    ? {
        title: `Stop the agent in chat ${String(chat)} of ${id}?`,
        description: (
          <>
            The agent is working now. Tasma stops it, and a new chat starts the step
            {" "}
            <span className="font-mono">{step}</span>
            .
          </>
        ),
        confirmLabel: "Stop and restart",
      }
    : {
        title: `Restart the step of ${id}?`,
        description: (
          <>
            A new chat starts the step
            {" "}
            <span className="font-mono">{step}</span>
            {`. Chat ${String(chat)} stays in the list.`}
          </>
        ),
        confirmLabel: "Restart",
      };

  return (
    <ConfirmDialog
      open={open}
      {...words}
      onCancel={onCancel}
      onConfirm={() => {
        if (!sentRef.current) {
          sentRef.current = true;
          onConfirm();
        }
      }}
      finalFocus={finalFocus}
      cancelRef={cancelRef}
      confirmRef={confirmRef}
    />
  );
}

/**
 * Asks before a restart of the chat of a step. Its words follow the state of
 * the chat while it is open. It sends nothing and opens a warning when the
 * reads of this open have all landed and show that the chat is no longer the
 * chat of its step; a read that is pending or failed keeps it open. Each open
 * mounts it again, so it decides on reads fetched after the open.
 */
export function RestartDialog(props: RestartDialogProps): ReactNode {
  const [opened, setOpened] = useState({ open: props.open, count: 0 });

  if (props.open !== opened.open) {
    setOpened({ open: props.open, count: props.open ? opened.count + 1 : opened.count });
  }

  return <RestartDialogBody key={opened.count} {...props} />;
}
