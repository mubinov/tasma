import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Client, Config, TaskEntry } from "@tasma/protocol";
import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { bodyCorrection, createRefusal, taskCreateOptions, type Created } from "../api/mutations";
import type { FinalFocus } from "../lib/final-focus";
import { CaretDownIcon, WarningIcon } from "../lib/icons";
import { createInput, firstDraft, hasContent, type TaskDraft } from "../lib/task-draft";
import { priorityChoices, statusChoices } from "../lib/task-properties";
import { BLANK_TITLE, isBlankTitle } from "../lib/text-draft";
import { useFocusEmptiedWhileOpening } from "../lib/use-focus-emptied-while-opening";
import { asSentences, useNoticeStore } from "../store/notices";
import { ConfirmDialog } from "./confirm-dialog";
import {
  BUTTON_CLASS,
  BUTTON_FILLED_CLASS,
  DIALOG_ACTIONS_CLASS,
  DIALOG_PANEL_WIDE_CLASS,
  DIALOG_SCRIM_CLASS,
  DIALOG_VIEWPORT_CLASS,
  FIELD_BORDER_CLASS,
  FIELD_ERROR_CLASS,
} from "./control-classes";
import { LabelPicker } from "./label-picker";
import { KeyHint, MarkdownEditor, MarkdownEditorHint } from "./markdown-editor";
import { PropertyMenu } from "./property-menu";

const CANNOT_CANCEL = "The task is being created and cannot be cancelled now.";

const ROW_LABEL_CLASS = "text-dim";

const TITLE_CLASS = `h-8 w-full rounded-control bg-surface px-2.5 text-sm text-text placeholder:text-dim ${FIELD_BORDER_CLASS}`;

const WORDS_CLASS = "mt-2 rounded-control bg-surface-2 px-2.5 py-2 font-mono text-xs-plus text-dim wrap-anywhere";

export type CreateTaskDialogProps = {
  queryClient: QueryClient;
  client: Client;
  tag: string;
  /** The statuses and the priorities the menus offer. */
  config: Config;
  /** Every task of the project, unfiltered, which the labels and their counts come from. */
  entries: readonly TaskEntry[];
  /** The status the draft starts with. */
  status: string;
  /** The control pressed, where focus returns when nothing is created. */
  opener: HTMLElement;
  /** Where focus returns when the opener has left the document. */
  newTaskRef: RefObject<HTMLElement | null>;
  /** Closed with nothing created. */
  onClose: () => void;
  /** The query cache already holds the new task. The dialog leaves focus where it is. */
  onCreated: (created: Created) => void;
};

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

function Caret(): ReactNode {
  return <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />;
}

/**
 * The create dialog: a draft of a task that is written once, on Create.
 *
 * It stays open while the write runs, since the write cannot be withdrawn and a
 * refusal needs the dialog to show in. A refusal shows inside it rather than as
 * a floating notice, which would sit under the scrim and out of the focus trap.
 */
export function CreateTaskDialog({
  queryClient,
  client,
  tag,
  config,
  entries,
  status,
  opener,
  newTaskRef,
  onClose,
  onCreated,
}: CreateTaskDialogProps): ReactNode {
  const { mutateAsync: create, isPending } = useMutation(taskCreateOptions(queryClient, client, tag));
  const [first] = useState(() => firstDraft(status));
  const [draft, setDraft] = useState(first);
  // A pick and a ⌘↩ of one key press both land before the render, so the
  // submit reads the draft from here.
  const draftRef = useRef(first);
  const sendingRef = useRef(false);
  const createdRef = useRef(false);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [bodyError, setBodyError] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<{ line: string; words: string } | null>(null);
  const [discardAsked, setDiscardAsked] = useState(false);
  const discardFocusRef = useRef<FinalFocus>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  const priorityId = useId();
  const labelsId = useId();
  const refusalId = useId();

  // Mounted only while open. The return focus is `opener`, not the element handed back.
  useFocusEmptiedWhileOpening(true);

  function change(fields: Partial<TaskDraft>): void {
    const previous = draftRef.current;
    const next = { ...previous, ...fields };

    draftRef.current = next;
    setDraft(next);
    if (!isBlankTitle(next.title)) {
      setTitleError(undefined);
    }
    if (next.body !== previous.body) {
      setBodyError(undefined);
    }
  }

  function focusTitle(): void {
    titleRef.current?.focus();
  }

  /** Cancel, Esc and a press on the scrim. */
  function requestClose(): void {
    if (sendingRef.current) {
      announce(CANNOT_CANCEL);
      return;
    }
    if (!hasContent(first, draftRef.current)) {
      onClose();
      return;
    }

    // A pointer press in WebKit focuses no button, and leaves focus on no control of the dialog.
    const focused = document.activeElement;
    const popup = popupRef.current;
    discardFocusRef.current = focused instanceof HTMLElement && focused !== popup && popup?.contains(focused) === true
      ? focused
      : cancelRef.current;
    setDiscardAsked(true);
  }

  function keepEditing(): void {
    setDiscardAsked(false);
  }

  function discard(): void {
    discardFocusRef.current = "keep";
    setDiscardAsked(false);
    onClose();
  }

  async function submit(): Promise<void> {
    if (sendingRef.current) {
      return;
    }

    const sent = draftRef.current;
    if (isBlankTitle(sent.title)) {
      // `Field.Error` is not a live region: a caret already in the input hears
      // the correction only when it is spoken. The focus move reads it on
      // every other path.
      const inTitle = document.activeElement === titleRef.current;
      setTitleError(BLANK_TITLE);
      focusTitle();
      if (inTitle) {
        announce(BLANK_TITLE);
      }
      return;
    }

    sendingRef.current = true;
    setRefusal(null);
    setBodyError(undefined);
    announce("Creating…");

    let created: Created;
    try {
      created = await create({ input: createInput(sent) });
    } catch (error) {
      sendingRef.current = false;
      const shown = createRefusal(error);
      const correction = bodyCorrection(error);
      setRefusal(shown);
      setBodyError(correction);
      announce(asSentences([
        "The task was not created",
        shown.line,
        shown.words,
        ...(correction === undefined ? [] : [correction]),
      ]));
      return;
    }

    createdRef.current = true;
    onCreated(created);
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(_open, details) => {
        details.cancel();
        // A held Esc acts on its first press alone, so the wait is said once.
        if (details.reason !== "escape-key" || !details.event.repeat) {
          requestClose();
        }
      }}
    >
      <Dialog.Portal>
        {/* The viewport draws above the scrim by DOM order alone, so it must stay after it. */}
        <Dialog.Backdrop className={DIALOG_SCRIM_CLASS} />
        <Dialog.Viewport className={DIALOG_VIEWPORT_CLASS}>
          <Dialog.Popup
            ref={popupRef}
            initialFocus={titleRef}
            // Base UI's own destination can be <body> once the opener has left.
            finalFocus={() => {
              if (createdRef.current) {
                return false;
              }

              return opener.isConnected ? opener : newTaskRef.current;
            }}
            // A value here replaces the one Base UI sets rather than joining it.
            aria-describedby={refusal === null ? undefined : refusalId}
            className={DIALOG_PANEL_WIDE_CLASS}
          >
            <Dialog.Title className="font-chrome text-lg font-semibold">New task</Dialog.Title>
            <form
              ref={formRef}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              // An open menu or picker renders through a portal, and its keys
              // still bubble here through the React tree.
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
            >
              <div className="mt-4 grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-sm">
                <Field.Root name="title" invalid={titleError !== undefined} className="contents">
                  <Field.Label className={ROW_LABEL_CLASS}>Title</Field.Label>
                  <Field.Control
                    ref={titleRef}
                    // Required to a screen reader alone: the native attribute
                    // would put the browser's own bubble in place of the line.
                    aria-required="true"
                    placeholder="Required"
                    value={draft.title}
                    onValueChange={(title) => {
                      change({ title });
                    }}
                    className={TITLE_CLASS}
                  />
                  {titleError !== undefined && (
                    <Field.Error match className={`col-start-2 ${FIELD_ERROR_CLASS}`}>{titleError}</Field.Error>
                  )}
                </Field.Root>
                <span id={statusId} className={ROW_LABEL_CLASS}>Status</span>
                <PropertyMenu
                  look="field"
                  labelId={statusId}
                  value={draft.status}
                  row={{
                    choices: statusChoices(config),
                    match: "without case",
                    busy: false,
                    onPick: (value) => {
                      // Not clearable, so a pick is always a status.
                      change({ status: value! });
                    },
                  }}
                  clearable={false}
                  trigger={(
                    <>
                      <span className="min-w-0 wrap-anywhere">{draft.status}</span>
                      <Caret />
                    </>
                  )}
                  onFocusLost={focusTitle}
                />
                <span id={priorityId} className={ROW_LABEL_CLASS}>Priority</span>
                <PropertyMenu
                  look="field"
                  labelId={priorityId}
                  value={draft.priority ?? undefined}
                  row={{
                    choices: priorityChoices(config),
                    match: "without case",
                    busy: false,
                    onPick: (priority) => {
                      change({ priority });
                    },
                  }}
                  clearable
                  trigger={(
                    <>
                      {draft.priority === null
                        ? <span className="text-dim">None</span>
                        : <span className="min-w-0 wrap-anywhere">{draft.priority}</span>}
                      <Caret />
                    </>
                  )}
                  onFocusLost={focusTitle}
                />
                <span id={labelsId} className={ROW_LABEL_CLASS}>Labels</span>
                <LabelPicker
                  look="field"
                  labelId={labelsId}
                  entries={entries}
                  labels={draft.labels}
                  row={{
                    busy: false,
                    onPick: (labels) => {
                      change({ labels });
                    },
                  }}
                />
                {/* The editor names itself with a hidden label of the same text. */}
                <span aria-hidden="true" className={`self-start pt-1.5 ${ROW_LABEL_CLASS}`}>Body</span>
                <MarkdownEditor
                  label="Body"
                  name="body"
                  value={draft.body}
                  onValueChange={(body) => {
                    change({ body });
                  }}
                  placeholder="Write in markdown"
                  error={bodyError}
                  controlClassName="min-h-30 max-h-[40vh] overflow-y-auto"
                  footer={(
                    <MarkdownEditorHint className="mt-1.5">
                      Markdown
                      {" "}
                      <span aria-hidden="true">·</span>
                      <KeyHint mark="⌘↩" spoken="Command Enter">create</KeyHint>
                      {" "}
                      <span aria-hidden="true">·</span>
                      <KeyHint mark="Esc" spoken="Escape">cancel</KeyHint>
                    </MarkdownEditorHint>
                  )}
                />
              </div>
              {refusal !== null && (
                <div id={refusalId} className="mt-5 flex gap-3">
                  <WarningIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-signal" />
                  <div className="min-w-0 flex-1">
                    <p className="font-chrome text-base font-medium text-signal">The task was not created</p>
                    <p className="mt-0.5 text-sm text-muted">{refusal.line}</p>
                    <p className={WORDS_CLASS}>{refusal.words}</p>
                  </div>
                </div>
              )}
              <div className={DIALOG_ACTIONS_CLASS}>
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={() => {
                    requestClose();
                  }}
                  className={BUTTON_CLASS}
                >
                  Cancel
                </button>
                {/* The wait shows in the label, never in `disabled`. */}
                <button type="submit" className={BUTTON_FILLED_CLASS}>{isPending ? "Creating…" : "Create"}</button>
              </div>
            </form>
            {/* Inside the popup, so Base UI nests it and Esc reaches it alone; outside the form, so its keys do
                not submit. */}
            <ConfirmDialog
              open={discardAsked}
              title="Discard your changes?"
              description="The new task is not created, and what you wrote is lost. There is no undo."
              cancelLabel="Keep editing"
              confirmLabel="Discard"
              onCancel={keepEditing}
              onConfirm={discard}
              finalFocus={discardFocusRef}
            />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
