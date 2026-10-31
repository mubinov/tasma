import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { chatStartOptions, type StartChat } from "../api/mutations";
import { chatRestartFailure, chatStartFailure } from "./write-failure";

/**
 * Starts the chat of a step of the task, or with `restart` replaces that chat
 * with a new one. A start can begin after its caller unmounted, and the
 * observer then has no listener to remove it from the mutation, so each start
 * releases its mutation when it ends.
 */
export function useChatStart(
  tag: string,
  id: string,
): (step: string, from: StartChat["from"], restart?: number) => void {
  const router = useRouter();
  const { client, queryClient } = router.options.context;
  const { mutateAsync, reset } = useMutation(chatStartOptions(queryClient, client, router), queryClient);

  return (step, from, restart) => {
    const variables: StartChat = restart === undefined
      ? { tag, id, step, from, failure: chatStartFailure(step, id) }
      : { tag, id, step, from, restart, failure: chatRestartFailure(step, id, restart) };

    void mutateAsync(variables)
      .catch(() => {
        // The failure notice is open.
      })
      .finally(() => {
        reset();
      });
  };
}
