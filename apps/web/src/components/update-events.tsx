import { MutationObserver, useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { updateRequestOptions, type UpdateRequest } from "../api/mutations";
import { UPDATE_EVENT } from "../api/paths";
import { updateQuery, type Update, type UpdateState } from "../api/queries";
import type { FinalFocus } from "../lib/final-focus";
import { useNoticeStore } from "../store/notices";
import { useUiStore, type UpdateDialog } from "../store/ui";
import { ConfirmDialog } from "./confirm-dialog";

const START_FAILED = "The update could not start.";
const RESTART_FAILED = "Tasma could not restart. Quit Tasma and open it again.";

/** The state each dialog shows; in any other state it closes. */
const DIALOG_STATE: Record<UpdateDialog["kind"], UpdateState> = {
  update: "available",
  restart: "ready",
  failure: "failed",
};

type UpdateDetail = { open?: unknown; restart?: unknown };

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

function send(queryClient: QueryClient, request: UpdateRequest): Promise<void> {
  return new MutationObserver(queryClient, updateRequestOptions(queryClient, request)).mutate();
}

/** Stops the app's restart limit. A failed request is sent one more time. */
async function wait(queryClient: QueryClient): Promise<void> {
  try {
    await send(queryClient, "wait");
  } catch {
    await send(queryClient, "wait").catch(() => undefined);
  }
}

/** A restart must not lose unsaved text without a warning. */
async function restartWhenSafe(queryClient: QueryClient, update: Update): Promise<void> {
  const { modalDialogs, unsavedPage, openUpdateDialog } = useUiStore.getState();

  if (modalDialogs > 0) {
    announce(`Tasma ${update.version} is installed. Restart from the sidebar.`);
    await wait(queryClient);
    return;
  }

  if (unsavedPage) {
    openUpdateDialog({ kind: "restart", returnTo: null });
    await wait(queryClient);
    return;
  }

  try {
    await send(queryClient, "restart");
  } catch {
    announce(RESTART_FAILED);
  }
}

/**
 * Reads the update again on each event the app dispatches, opens the update
 * dialog a menu check asks for, runs the restart rule, and renders the three
 * update dialogs, so they open also where no sidebar is shown.
 */
export function UpdateEvents({ queryClient }: { queryClient: QueryClient }): ReactNode {
  useEffect(() => {
    let seen: UpdateState | undefined;

    async function respond(detail: UpdateDetail): Promise<void> {
      const update = await queryClient.query({ ...updateQuery(), staleTime: 0 });
      if (update === null) {
        return;
      }

      const before = seen;
      seen = update.state;

      if (update.state === "failed" && before !== "failed") {
        announce(`The update to ${update.version} failed. ${update.error}`);
      }

      const { modalDialogs, openUpdateDialog } = useUiStore.getState();
      if (detail.open === true && update.state === "available" && modalDialogs === 0) {
        openUpdateDialog({ kind: "update", returnTo: null });
      }

      if (detail.restart === true && update.state === "ready") {
        await restartWhenSafe(queryClient, update);
      }
    }

    function listen(event: Event): void {
      const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;

      void respond(typeof detail === "object" && detail !== null ? detail : {});
    }

    window.addEventListener(UPDATE_EVENT, listen);

    return () => {
      window.removeEventListener(UPDATE_EVENT, listen);
    };
  }, [queryClient]);

  return <UpdateDialogs queryClient={queryClient} />;
}

/**
 * Reads the update itself, never from a prop: an open request re-renders this
 * component alone, before the query notifies its observers, and a prop would
 * still hold the state from before the event.
 */
function UpdateDialogs({ queryClient }: { queryClient: QueryClient }): ReactNode {
  const { data: update } = useQuery(updateQuery(), queryClient);
  const kind = useUiStore((state) => state.updateDialog?.kind ?? null);
  const returnTo = useUiStore((state) => state.updateDialog?.returnTo ?? null);
  const closeUpdateDialog = useUiStore((state) => state.closeUpdateDialog);
  const install = useMutation(updateRequestOptions(queryClient, "install"), queryClient);
  const restart = useMutation(updateRequestOptions(queryClient, "restart"), queryClient);
  const finalFocusRef = useRef<FinalFocus>(null);
  const [restartStatus, setRestartStatus] = useState<string | undefined>(undefined);
  const shows = kind !== null && DIALOG_STATE[kind] === update?.state;

  // Set only while a dialog is open: the dialog reads it as it closes.
  useEffect(() => {
    if (kind !== null) {
      finalFocusRef.current = returnTo;
    }
  }, [kind, returnTo]);

  // A dialog whose state has passed closes, so it does not open again when the
  // state comes back.
  useEffect(() => {
    if (kind !== null && !shows) {
      closeUpdateDialog();
    }
  }, [kind, shows, closeUpdateDialog]);

  function close(): void {
    setRestartStatus(undefined);
    closeUpdateDialog();
  }

  if (update === undefined || update === null) {
    return null;
  }

  const version = update.version;

  function startInstall(): void {
    close();
    install.mutate(undefined, {
      onSuccess: () => {
        announce(`Installing Tasma ${version}.`);
      },
      onError: () => {
        announce(START_FAILED);
      },
    });
  }

  function restartNow(): void {
    restart.mutate(undefined, {
      onError: () => {
        setRestartStatus(RESTART_FAILED);
        announce(RESTART_FAILED);
      },
    });
  }

  return (
    <>
      <ConfirmDialog
        open={shows && kind === "update"}
        title={`Tasma ${version} is available`}
        description={(
          <>
            {`Current version: ${update.current}. Tasma restarts to install the update.`}
            {" "}
            <a href={update.releaseUrl} target="_blank" rel="noreferrer" className="text-text underline underline-offset-2">
              Release page
            </a>
          </>
        )}
        cancelLabel="Later"
        confirmLabel="Install and restart"
        onCancel={close}
        onConfirm={startInstall}
        finalFocus={finalFocusRef}
      />
      <ConfirmDialog
        open={shows && kind === "failure"}
        title={`The update to ${version} failed`}
        description={`${update.error} Tasma ${update.current} is still installed.`}
        cancelLabel="Close"
        confirmLabel="Try again"
        onCancel={close}
        onConfirm={startInstall}
        finalFocus={finalFocusRef}
      />
      <ConfirmDialog
        open={shows && kind === "restart"}
        title={`Tasma ${version} is installed`}
        description="Tasma must restart to finish the update. Unsaved text is lost when it restarts."
        cancelLabel="Later"
        confirmLabel="Restart now"
        onCancel={close}
        onConfirm={restartNow}
        finalFocus={finalFocusRef}
        status={restartStatus}
      />
    </>
  );
}
