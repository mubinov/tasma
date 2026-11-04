import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { Client, SkillInstall } from "@tasma/protocol";
import { useNoticeStore } from "../../store/notices";
import { daemonKeys } from "../queries";
import { openWriteNotice, refusalWords, WriteError, type WriteFailure } from "./notices";

export type SkillInstallWrite = {
  failure: WriteFailure;
  /** The screen shows the install button, which the notice sends the user to. */
  offered: () => boolean;
};

const SKILL_INSTALL_FAILURE_KEY = "skill-install-failure";

export function closeSkillInstallFailure(): void {
  useNoticeStore.getState().closeNotice(SKILL_INSTALL_FAILURE_KEY);
}

/** Each request is held by the daemon for up to 25 seconds, so the loop does not poll quickly. */
async function installToEnd(client: Client): Promise<SkillInstall> {
  let { data } = await client.installSkill();

  while (data.result === "running") {
    ({ data } = await client.installSkill(data.run));
  }

  return data;
}

export function installSkillOptions(queryClient: QueryClient, client: Client) {
  return mutationOptions<SkillInstall, WriteError, SkillInstallWrite>({
    mutationKey: [...daemonKeys.setup(), "skill-install"],
    mutationFn: async () => {
      try {
        return await installToEnd(client);
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    // A write whose answer is lost may have been carried out.
    retry: 0,
    onSuccess: () => {
      closeSkillInstallFailure();

      // Returned, so step 4 goes from the run to Done with no idle state between them.
      return queryClient.invalidateQueries({ queryKey: daemonKeys.setup() });
    },
    onError: (error, { failure, offered }) => {
      if (!offered()) {
        return;
      }

      openWriteNotice({
        key: SKILL_INSTALL_FAILURE_KEY,
        form: "failure",
        title: failure.title,
        line: failure.line(error),
        words: [refusalWords(error)],
      });
    },
  });
}
