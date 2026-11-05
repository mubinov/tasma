import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { ProtocolError, type Client, type Project, type SkillInstall, type StoreErrorCode } from "@tasma/protocol";
import { useNoticeStore } from "../../store/notices";
import { daemonKeys } from "../queries";
import { openWriteNotice, refusalWords, WriteError, type WriteFailure } from "./notices";

/** The tag of a project whose folder name gives no tag. */
const GENERIC_TAG = "PROJ";

const SETUP_WORKFLOW = "dev";

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

function refusedWith(cause: unknown, code: StoreErrorCode): boolean {
  return cause instanceof ProtocolError && cause.failure.code === code;
}

/** The workflow write was refused because the project is no longer under its tag. */
export function projectGone(error: WriteError): boolean {
  return refusedWith(error.cause, "project-not-found");
}

async function createProject(client: Client, path: string): Promise<Project> {
  try {
    return (await client.createProject({ path })).data;
  } catch (cause) {
    if (!refusedWith(cause, "tag-not-generated")) {
      throw cause;
    }
  }

  return (await client.createProject({ path, tag: GENERIC_TAG })).data;
}

export function createProjectOptions(queryClient: QueryClient, client: Client) {
  return mutationOptions<Project, WriteError, { path: string }>({
    mutationKey: [...daemonKeys.setup(), "project-create"],
    mutationFn: async ({ path }) => {
      try {
        return await createProject(client, path);
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    retry: 0,
    // Not returned: a full setup read can take seconds, and the workflow write does not wait for it.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: daemonKeys.setup() });
      void queryClient.invalidateQueries({ queryKey: daemonKeys.projects() });
    },
  });
}

export function addWorkflowOptions(queryClient: QueryClient, client: Client) {
  return mutationOptions<void, WriteError, { tag: string }>({
    mutationKey: [...daemonKeys.setup(), "workflow-add"],
    mutationFn: async ({ tag }) => {
      try {
        await client.installWorkflow(SETUP_WORKFLOW);
        // `workflows` replaces the list of the project, which is empty while the workflow check fails.
        await client.updateProject(tag, { workflows: [SETUP_WORKFLOW] });
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    retry: 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: daemonKeys.projects() });
      void queryClient.invalidateQueries({ queryKey: daemonKeys.workflows() });
      void queryClient.invalidateQueries({ queryKey: daemonKeys.workflowList() });

      // Returned, so step 6 goes from the write to Done with no idle state between them.
      return queryClient.invalidateQueries({ queryKey: daemonKeys.setup() });
    },
    onError: (error) => {
      if (projectGone(error)) {
        void queryClient.invalidateQueries({ queryKey: daemonKeys.projects() });
      }
    },
  });
}
