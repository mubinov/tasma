import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@base-ui/react/button";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useModalDialog } from "../store/notices";
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

/** How long the status region is held back from its first write, counted from the popup's mount. */
const STATUS_HOLD = 1000;

type DialogStatusProps = { status: string | undefined };

/**
 * The dialog's own spoken line. It mounts with the popup and stays mounted and
 * empty until the hold elapses: a live region written into in the same commit
 * it arrives in announces nothing. Writes after the first land at once, so the
 * hold is a gate and not a debounce, and a status that changes more than once
 * inside it resolves to the latest value.
 *
 * The words key the message node inside the region and never the region
 * itself, which would remount it and defeat both rules: changed words are a new
 * node, and so a new addition to speak, while two identical consecutive values
 * are one node and are spoken once. The caller separates a repeated message by
 * passing an empty status between.
 */
function DialogStatus({ status }: DialogStatusProps): ReactNode {
  const [held, setHeld] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setHeld(false);
    }, STATUS_HOLD);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  const words = held ? "" : (status ?? "");

  // On screen rather than sr-only: one node serves both audiences, so a sighted
  // reader gets the reason a refused write left the dialog open.
  return (
    <div role="status" className={DIALOG_STATUS_CLASS}>
      <span key={words}>{words}</span>
    </div>
  );
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
  finalFocus: RefObject<HTMLElement | null>;
  /**
   * Spoken inside the dialog: the wait, then a refusal. A caller that keeps the
   * dialog open across a write must pass both — the failure mode is silence.
   */
  status?: string;
};

/**
 * The confirmation dialog. `AlertDialog` hard-codes modal, the alertdialog role
 * and "an outside press never dismisses", so none of the three can be set
 * wrong, and Base UI hides everything outside the popup — which is why the
 * status region sits inside it.
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
  useModalDialog(open);

  return (
    <AlertDialog.Root
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
            // fallback. Returning true takes the fallback instead.
            finalFocus={() => {
              const destination = finalFocus.current;

              return destination?.isConnected === true ? destination : true;
            }}
            className={DIALOG_PANEL_CLASS}
          >
            {/* The class every h2 of the application already takes. */}
            <AlertDialog.Title className="font-chrome text-lg font-semibold tracking-tight">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description className={DIALOG_BODY_CLASS}>{description}</AlertDialog.Description>
            <DialogStatus status={status} />
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
