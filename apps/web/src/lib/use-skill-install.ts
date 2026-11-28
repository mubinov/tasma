import { useMutation, type QueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { Client } from "@tasma/protocol";
import {
  installSkillOptions,
  usePendingSkillInstall,
  type SkillInstallEnd,
  type SkillInstallWrite,
  type WriteError,
} from "../api/mutations";
import { installsNothing, skillInstallState, type InstallResult, type SkillInstallState } from "./setup-steps";

export type SkillInstallOfPlace = {
  install: UseMutationResult<SkillInstallEnd, WriteError, SkillInstallWrite>;
  /** The last install of this place installed nothing. */
  result: InstallResult | undefined;
  state: SkillInstallState | undefined;
  /** The number of agents of the install that runs, in any place. */
  runningAgentCount: number;
};

/** The skill install of one place, the screen or the dialog of an agent, and the install that runs in any place. */
export function useSkillInstall(queryClient: QueryClient, client: Client): SkillInstallOfPlace {
  const install = useMutation(installSkillOptions(queryClient, client));
  const running = usePendingSkillInstall();
  const result = install.data !== undefined && installsNothing(install.data)
    ? { answer: install.data, agents: install.variables.agents }
    : undefined;

  return {
    install,
    result,
    state: skillInstallState(running !== undefined, result),
    runningAgentCount: running?.length ?? 0,
  };
}
