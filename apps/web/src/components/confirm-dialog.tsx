import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@base-ui/react/button";
import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { FinalFocus } from "../lib/final-focus";
import {
  BUTTON_CLASS,
  BUTTON_FILLED_CLASS,
  DIALOG_ACTIONS_CLASS,
  DIALOG_BODY_CLASS,
  DIALOG_PANEL_CLASS,
  DIALOG_SCRIM_CLASS,
  DIALOG_STATUS_CLASS,
  DIALOG_VIEWPORT_CLASS,
} from "./control-classes";

/**
 * Empties focus while the dialog opens, and hands back the element it took it
 * from.
 *
 * Chrome refuses `aria-hidden` on an element a focused descendant sits under,
 * and does not re-evaluate once focus leaves — so a dialog opened by a pointer
 * click would leave the container of the clicked control readable by a screen
 * reader for the life of that dialog. Base UI hides the outside elements from a
 * passive effect and moves focus into the popup a frame later, which leaves
 * this layout effect the one place between them.
 *
 * Base UI records its own return destination only once the popup registers its
 * element, a commit after this one, so by then focus is already on nothing.
 * The element handed back is therefore the only fallback the dialog has.
 */
function useFocusEmptiedWhileOpening(open: boolean): RefObject<HTMLElement | null> {
  const openerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const focused = document.activeElement;
    const opener = focused instanceof HTMLElement && focused !== document.body ? focused : null;

    openerRef.current = opener;
    opener?.blur();
  }, [open]);

  return openerRef;
}

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  /**
   * Inline content only. The part renders a `p`, so a list or a second
   * paragraph here nests a block inside it and breaks the panel's spacing.
   */
  description: ReactNode;
  cancelLabel?: string;
  /** Also where a wait shows: "Deleting…", never `disabled`. */
  confirmLabel: string;
  /** Runs for every way the dialog closes itself, which is Esc and Cancel. */
  onCancel: () => void;
  /**
   * Closes nothing: only the caller knows when a write it starts is done. It
   * runs once per activation and the control stays operable while a wait shows
   * in `confirmLabel`, so a caller whose write must not repeat guards it.
   */
  onConfirm: () => void;
  /**
   * Where focus goes when the dialog closes. Required: the component names no
   * default. A destination that has left the document falls back to the
   * element focused before the dialog opened, which on a route change is gone
   * too, so a caller names one that survives the dialog's unmount.
   */
  finalFocus: RefObject<FinalFocus>;
  /**
   * Visible text under the description, e.g. the wait for a write, and part of
   * the dialog's accessible description, so it is read when the dialog is
   * entered. The dialog announces nothing: the caller announces.
   */
  status?: string;
};

/**
 * The confirmation dialog. `AlertDialog` hard-codes modal, the alertdialog role
 * and "an outside press never dismisses", so none of the three can be set
 * wrong.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  cancelLabel = "Cancel",
  confirmLabel,
  onCancel,
  onConfirm,
  finalFocus,
  status,
}: ConfirmDialogProps): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<AlertDialog.Root.Actions>(null);
  const descriptionId = useId();
  const statusId = useId();
  const openerRef = useFocusEmptiedWhileOpening(open);

  // Base UI unmounts a closed popup, and returns focus, only an animation frame
  // later. The panel has no exit animation, so it unmounts in the commit that
  // closes it, and focus lands before words announced with the close.
  useLayoutEffect(() => {
    if (!open) {
      actionsRef.current?.unmount();
    }
  }, [open]);

  return (
    <AlertDialog.Root
      actionsRef={actionsRef}
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <AlertDialog.Portal>
        {/* The viewport draws above the scrim by DOM order alone, so it must stay after it. */}
        <AlertDialog.Backdrop className={DIALOG_SCRIM_CLASS} />
        <AlertDialog.Viewport className={DIALOG_VIEWPORT_CLASS}>
          <AlertDialog.Popup
            // Explicit, though the default lands there by DOM order: a control
            // added later would otherwise move where focus starts, silently.
            initialFocus={cancelRef}
            // A detached destination is truthy to Base UI, which then calls
            // focus() on a disconnected node and leaves focus on <body> with no
            // fallback. The element the dialog took focus from stands in.
            finalFocus={() => {
              const destination = finalFocus.current;
              if (destination === "keep") {
                return false;
              }

              if (destination?.isConnected === true) {
                return destination;
              }

              const opener = openerRef.current;

              return opener?.isConnected === true ? opener : true;
            }}
            // A value here replaces the description id Base UI sets rather than
            // joining it, so both ids are named, the description first.
            aria-describedby={status === undefined || status === "" ? descriptionId : `${descriptionId} ${statusId}`}
            className={DIALOG_PANEL_CLASS}
          >
            {/* The class every h2 of the application already takes. */}
            <AlertDialog.Title className="font-chrome text-lg font-semibold">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description id={descriptionId} className={DIALOG_BODY_CLASS}>
              {description}
            </AlertDialog.Description>
            <div id={statusId} className={DIALOG_STATUS_CLASS}>{status}</div>
            <div className={DIALOG_ACTIONS_CLASS}>
              <AlertDialog.Close ref={cancelRef} className={BUTTON_CLASS}>
                {cancelLabel}
              </AlertDialog.Close>
              <Button type="button" onClick={onConfirm} className={BUTTON_FILLED_CLASS}>
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
