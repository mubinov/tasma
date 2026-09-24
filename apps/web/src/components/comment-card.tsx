import { Collapsible } from "@base-ui/react/collapsible";
import { Menu } from "@base-ui/react/menu";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Client, Comment } from "@tasma/protocol";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  commentFailureTitle,
  commentWriteOptions,
  usePendingCollapsed,
  refusalWords,
} from "../api/mutations";

import type { FinalFocus } from "../lib/final-focus";
import { CaretDownIcon, CheckIcon, DotsThreeVerticalIcon } from "../lib/icons";
import { formatStamp } from "../lib/task-page";
import { commentWords, subjectWords } from "../lib/unsaved-words";
import type { CommentClose } from "../lib/use-comment-editing";
import type { UnsavedGuard } from "../lib/use-unsaved-guard";
import { pageFailureLine } from "../lib/write-failure";
import { useNoticeStore } from "../store/notices";
import { EditingComment } from "./comment-editor";
import { ConfirmDialog } from "./confirm-dialog";
import { MENU_ITEM_CLASS, POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";
import { Markdown } from "./markdown";

export type CommentCardProps = {
  comment: Comment;
  queryClient: QueryClient;
  client: Client;
  /** The project the task belongs to. */
  tag: string;
  /** The task the comment belongs to. */
  taskId: string;
  /** The `updated` of the task read, for a comment that carries no stamp of its own. */
  taskUpdated: string;
  /** Another comment follows this one, so the serializer writes its body's last line end back. */
  lineEndRestored: boolean;
  /** The card renders its editor in place of the comment. */
  editing: boolean;
  /** The comment left the file while this editor was open. */
  removed: boolean;
  guard: UnsavedGuard;
  onEdit: () => void;
  onCloseEditor: (close: CommentClose) => void;
  /** The write that removed the comment landed. The caller lands the caret. */
  onDeleted: () => void;
};

/** The caret folds the comment for this reader alone and writes nothing. */
export function CommentCard({
  comment,
  queryClient,
  client,
  tag,
  taskId,
  taskUpdated,
  lineEndRestored,
  editing,
  removed,
  guard,
  onEdit,
  onCloseEditor,
  onDeleted,
}: CommentCardProps): ReactNode {
  const titleId = useId();
  const itemRef = useRef<HTMLLIElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const deleteFocusRef = useRef<FinalFocus>("keep");
  const [deleteAsked, setDeleteAsked] = useState(false);
  const [deleteRefusal, setDeleteRefusal] = useState<string | undefined>(undefined);
  const { id, author, created, body, collapsed } = comment;
  const hasBody = body.trim() !== "";
  const words = commentWords(id);
  const headWords = subjectWords({ kind: "comment", id });
  // A comment with no title is named by its id wherever a title would resolve to nothing.
  const name = comment.title.trim() === "" ? headWords : comment.title;
  const { mutate: writeFlag } = useMutation(commentWriteOptions(queryClient, client, tag));
  const { mutateAsync: writeDelete, isPending: deleting } = useMutation(
    commentWriteOptions(queryClient, client, tag),
  );
  // The state moves from the pending write, so the reader hears the flag they
  // chose at once; the file value alone would sit on the opposite state for a
  // whole refetch, and say nothing at all where they press Esc in that gap.
  const checked = usePendingCollapsed(tag, taskId, id, collapsed === true);

  // The header is a new element when a poll gives the comment text.
  useLayoutEffect(() => {
    const item = itemRef.current;
    const header = headerRef.current;
    if (editing || !hasBody || item === null || header === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      item.style.setProperty("--comment-header-height", `${String(header.offsetHeight)}px`);
    });
    observer.observe(header);

    return () => {
      observer.disconnect();
    };
  }, [editing, hasBody]);

  function toggleCollapsed(next: boolean): void {
    writeFlag({
      id: taskId,
      failure: { title: commentFailureTitle(taskId, id, "changed"), line: (error) => pageFailureLine(error) },
      kind: "update",
      commentId: id,
      // `null` is a removal, so the key leaves the marker exactly as
      // `--clear collapsed` does; `false` would write the default into the file.
      change: { collapsed: next ? true : null },
    });
  }

  async function runDelete(): Promise<void> {
    // `ConfirmDialog` keeps the control operable while the wait shows, so the
    // second activation is guarded here.
    if (deleting) {
      return;
    }

    setDeleteRefusal(undefined);
    useNoticeStore.getState().announce(`Deleting ${words}…`);
    try {
      await writeDelete({
        id: taskId,
        failure: { title: commentFailureTitle(taskId, id, "deleted"), line: (error) => pageFailureLine(error) },
        kind: "delete",
        commentId: id,
      });
    } catch (error) {
      // The dialog stays open with the daemon's own words, and the notice the
      // factory opened is the record the reader can return to. The words are
      // not spoken here: the notice announces itself as it opens.
      setDeleteRefusal(refusalWords(error));
      return;
    }

    setDeleteAsked(false);
    onDeleted();
    useNoticeStore.getState().announce(`${headWords} deleted.`);
  }

  if (editing) {
    return (
      <li ref={itemRef}>
        <EditingComment
          options={{
            queryClient,
            client,
            tag,
            taskId,
            subject: { kind: "comment", id },
            disk: removed ? null : { title: comment.title, body },
            updated: comment.updated ?? taskUpdated,
            lineEndRestored,
            guard,
            onClose: onCloseEditor,
          }}
          heading={name}
          meta={<CommentMeta id={id} author={author} created={created} />}
        />
      </li>
    );
  }

  return (
    <li ref={itemRef}>
      {/* The open state starts again when a poll gives the comment text or takes it away. */}
      <Collapsible.Root
        key={hasBody ? "text" : "marker"}
        render={<article />}
        data-comment-id={id}
        aria-labelledby={titleId}
        defaultOpen={hasBody && collapsed !== true}
        className="group/comment mt-3 rounded-card border border-line bg-surface"
      >
        {/* The top of the comment for the contents outline: the sticky header does not move with it. */}
        <span data-outline-sentinel="" className="block" />
        {/* A sticky header needs every box around it without overflow clipping, the card included. */}
        <div
          ref={headerRef}
          className="sticky top-top-bar z-(--layer-comment-header) rounded-t-card bg-surface px-4 pt-3 group-data-closed/comment:rounded-b-card group-data-closed/comment:pb-3 group-data-open/comment:border-b group-data-open/comment:border-line group-data-open/comment:pb-2"
        >
          <div className="flex items-center gap-1">
            {/* The heading is what names the card, so a comment with no title carries its id here. */}
            <h3 id={titleId} className="mr-2 min-w-0 flex-1 font-chrome text-base font-medium wrap-anywhere">
              {name}
            </h3>
            {/* Always visible, unlike the board's: a comment card carries no
                other affordance, and the sticky header it sits in is often the
                only part of a long comment on the screen. */}
            <Menu.Root highlightItemOnHover={false}>
              <Menu.Trigger
                data-comment-menu=""
                aria-label={`${headWords} actions`}
                aria-describedby={titleId}
                className="flex size-6 shrink-0 items-center justify-center rounded-control text-dim hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
              >
                <DotsThreeVerticalIcon size={16} aria-hidden="true" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
                  <Menu.Popup className={`min-w-52 ${POPUP_CLASS}`}>
                    <Menu.Item onClick={onEdit} className={MENU_ITEM_CLASS}>
                      <span className="w-3.5 shrink-0" />
                      Edit
                    </Menu.Item>
                    {/* The item keeps focus, which is what lets the native state
                        change be heard; so the flag needs no spoken message. */}
                    <Menu.CheckboxItem
                      closeOnClick={false}
                      checked={checked}
                      onCheckedChange={toggleCollapsed}
                      className={MENU_ITEM_CLASS}
                    >
                      {/* Forced colours overrides a colour but not `visibility`,
                          so the check keeps its box either way. */}
                      <Menu.CheckboxItemIndicator keepMounted className="flex w-3.5 shrink-0 data-[unchecked]:invisible">
                        <CheckIcon size={14} aria-hidden="true" />
                      </Menu.CheckboxItemIndicator>
                      Collapsed by default
                    </Menu.CheckboxItem>
                    <Menu.Separator className="my-1.5 h-px bg-line" />
                    <Menu.Item
                      onClick={() => {
                        // A refusal that landed after the last dialog was cancelled is not this one's.
                        setDeleteRefusal(undefined);
                        // A Cancel on the last dialog handed focus back to Base UI.
                        deleteFocusRef.current = "keep";
                        setDeleteAsked(true);
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      <span className="w-3.5 shrink-0" />
                      Delete
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            {hasBody && (
              <Collapsible.Trigger
                aria-label={`${headWords} text`}
                aria-describedby={titleId}
                className="flex size-6 shrink-0 items-center justify-center rounded-control text-dim hover:text-text"
              >
                <CaretDownIcon
                  size={14}
                  aria-hidden="true"
                  className="transition-transform duration-(--duration-fast) group-data-closed/comment:-rotate-90"
                />
              </Collapsible.Trigger>
            )}
          </div>
          <CommentMeta id={id} author={author} created={created} />
        </div>
        {hasBody && (
          // A focus scroll stops at the page's scroll padding, which clears the top bar and the focus ring but not the
          // stuck header.
          <Collapsible.Panel className="px-4 pt-2.5 pb-3.5 [&_*]:scroll-mt-(--comment-header-height)">
            <Markdown text={body} base={4} />
          </Collapsible.Panel>
        )}
      </Collapsible.Root>
      <ConfirmDialog
        open={deleteAsked}
        title={`Delete ${words}?`}
        description={`"${name}" is removed from the task file. There is no undo.`}
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        onCancel={() => {
          // Base UI returns focus to the menu button it opened from.
          deleteFocusRef.current = null;
          setDeleteAsked(false);
          setDeleteRefusal(undefined);
        }}
        onConfirm={() => {
          void runDelete();
        }}
        finalFocus={deleteFocusRef}
        // The words differ from the label on purpose: identical text in a label
        // and a status is read twice by a reader holding the confirm button.
        status={deleting ? `Deleting ${words}…` : deleteRefusal}
      />
    </li>
  );
}

type CommentMetaProps = { id: number; author?: string; created: string };

/** The id, the author and the date, which keep their place while the card is edited. */
function CommentMeta({ id, author, created }: CommentMetaProps): ReactNode {
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-xs-plus text-dim">
      <span className="font-mono text-xs">{`#${String(id)}`}</span>
      {author !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 wrap-anywhere">{author}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <time dateTime={created}>{formatStamp(created)}</time>
    </p>
  );
}
