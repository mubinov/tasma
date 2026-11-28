import { Accordion } from "@base-ui/react/accordion";
import { Dialog } from "@base-ui/react/dialog";
import { useRouter } from "@tanstack/react-router";
import type { ChatAgent } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { agentSkillTexts, agentTexts } from "../lib/agent-texts";
import {
  agentSetUp,
  agentSteps,
  currentStep,
  fullReadsFailing,
  hasFullAnswer,
  hasFullFailure,
  installFailedWords,
  installsNothing,
  installStartedWords,
  newestSetup,
  noNpxWords,
  READ_FAILED_WORDS,
  stepInputNow,
  stepsNowDone,
  STILL_CANNOT_CHECK_WORDS,
  type StepId,
  type StepState,
} from "../lib/setup-steps";
import { useFocusEmptiedWhileOpening } from "../lib/use-focus-emptied-while-opening";
import { useFullSetupRead } from "../lib/use-full-setup-read";
import { useQueryCache } from "../lib/use-query-cache";
import { useSetupFocusFallback } from "../lib/use-setup-focus-fallback";
import { useSkillInstall } from "../lib/use-skill-install";
import { useStepPanels } from "../lib/use-step-panels";
import { skillAgentFailure, skillInstallFailure, type SetupFailure } from "../lib/write-failure";
import { asSentences, useNoticeStore } from "../store/notices";
import { useModalDialog, useUiStore } from "../store/ui";
import {
  BUTTON_CLASS,
  DIALOG_ACTIONS_CLASS,
  DIALOG_BODY_CLASS,
  DIALOG_PANEL_WIDE_CLASS,
  DIALOG_SCRIM_CLASS,
  DIALOG_STATUS_CLASS,
  DIALOG_VIEWPORT_CLASS,
} from "./control-classes";
import { AgentStepContent, SetupStepRow, type SkillInstallRun } from "./setup-step";

const HOLD_WORDS = "The skill install is in progress. You can close this dialog after it ends.";

const STOPPED_WORDS = "Tasma does not check for the skill now, for any agent.";

export type AgentSetupDialogProps = {
  agent: ChatAgent;
  /** The control pressed, where focus returns on close. */
  opener: HTMLElement;
  /** Moves focus on close when the opener has left the page. */
  focusFallback: () => void;
  onClose: () => void;
};

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

/**
 * The steps of one agent, with their own reads and their own install. A failure shows inside the dialog, not as a
 * notice, which would sit under the scrim and out of the focus trap. Mounted only while open.
 */
export function AgentSetupDialog({ agent, opener, focusFallback, onClose }: AgentSetupDialogProps): ReactNode {
  const { queryClient, client } = useRouter().options.context;
  const skillCheckStopped = useUiStore((state) => state.skillCheckStopped);
  const status = useQueryCache(queryClient, newestSetup);
  const fullAnswered = useQueryCache(queryClient, hasFullAnswer);
  const fullFailed = useQueryCache(queryClient, hasFullFailure);
  const readFailedShown = useQueryCache(queryClient, fullReadsFailing) && fullAnswered;
  const { name } = agentTexts(agent);
  const skillTexts = agentSkillTexts(agent);
  const setUpWords = `${name} is set up. Close this dialog to continue.`;

  const readNow = useFullSetupRead(client, true);
  const { install, result, state: skillInstall, runningAgentCount } = useSkillInstall(queryClient, client);
  const installFailure = skillInstallFailure(skillTexts.button);
  const failure: SetupFailure | undefined = install.error === null
    ? undefined
    : { title: installFailure.title, line: installFailure.line(install.error) };

  const steps = agentSteps(agent, { status, fullAnswered, fullFailed, skillCheckStopped, skillInstall });
  const skillStep = steps.find(({ id }) => id === "skill")!;
  const current = currentStep(steps);
  const stateKey = steps.map(({ state }) => state).join();
  const setUp = agentSetUp(steps);

  const [checking, setChecking] = useState<StepId | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const setUpId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [popup, setPopup] = useState<HTMLElement | null>(null);
  const panels = useStepPanels(popup, steps, current, fullAnswered);
  const holdFocus = useSetupFocusFallback(popup, titleRef, current?.id, true);
  const lastRef = useRef({ steps, setUp });

  // The return focus is `opener`, not the element handed back.
  useFocusEmptiedWhileOpening(true);
  useModalDialog(true);

  useEffect(() => {
    if (readFailedShown) {
      announce(READ_FAILED_WORDS);
    }
  }, [readFailedShown]);

  const followChange = useEffectEvent(() => {
    const last = lastRef.current;
    const nowDone = stepsNowDone(last.steps, steps);

    lastRef.current = { steps, setUp };

    // The result and the failure of an install go when its step is done, also if the check fails again later.
    if (nowDone.some(({ id }) => id === "skill")) {
      install.reset();
    }
    for (const step of nowDone) {
      announce(`${step.name}: done.`);
    }
    if (setUp && !last.setUp) {
      announce(setUpWords);
    }

    panels.follow(true);
  });

  useLayoutEffect(() => {
    followChange();
  }, [stateKey, fullAnswered]);

  function stateNow(step: StepId): StepState | undefined {
    return agentSteps(agent, stepInputNow(queryClient)).find(({ id }) => id === step)?.state;
  }

  async function checkAgain(step: StepId): Promise<void> {
    if (checking !== null) {
      return;
    }

    setChecking(step);
    const answer = await readNow();
    setChecking(null);

    const state = stateNow(step);

    if (answer.isError || state === "cannot-check" || state === "not-run") {
      announce(STILL_CANNOT_CHECK_WORDS);
    }
  }

  function startInstall(): void {
    if (skillInstall === "running") {
      return;
    }

    announce(installStartedWords(1));
    // `offered` false: a notice would sit under the scrim, so step 3 shows the failure.
    const write = { agents: [agent], failure: installFailure, offered: () => false, agentFailure: skillAgentFailure };

    install.mutate(write, {
      onSuccess: (answer) => {
        if (!installsNothing(answer) || stateNow("skill") !== "to-do") {
          return;
        }

        announce(answer.result === "npx-missing" ? noNpxWords(skillStep.number) : installFailedWords(skillStep.number));
      },
      onError: (error) => {
        if (stateNow("skill") === "to-do") {
          announce(asSentences([installFailure.title, installFailure.line(error)]));
        }
      },
    });
  }

  function stopChecking(): void {
    useUiStore.getState().setSkillCheckStopped(true);
    announce(STOPPED_WORDS);
  }

  const installRun: SkillInstallRun = {
    state: skillInstall,
    result,
    runningAgentCount,
    texts: skillTexts,
    failure,
    onInstall: startInstall,
  };

  /** Close, Esc and a press outside the panel. The install of the dialog holds it open, so its result is not lost. */
  function requestClose(): void {
    if (install.isPending) {
      announce(HOLD_WORDS);
      return;
    }

    onClose();
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(_open, details) => {
        details.cancel();
        // A held Esc acts on its first press alone.
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
            ref={setPopup}
            initialFocus={titleRef}
            // Base UI's own destination can be <body> once the opener has left.
            finalFocus={() => {
              if (opener.isConnected) {
                return opener;
              }

              focusFallback();
              return false;
            }}
            // A value here replaces the one Base UI sets rather than joining it, also when it is undefined.
            aria-describedby={setUp ? `${descriptionId} ${setUpId}` : descriptionId}
            onFocus={holdFocus}
            className={DIALOG_PANEL_WIDE_CLASS}
          >
            <Dialog.Title ref={titleRef} id={titleId} tabIndex={-1} className="font-chrome text-lg font-semibold">
              {`Set up ${name}`}
            </Dialog.Title>
            <Dialog.Description id={descriptionId} className={DIALOG_BODY_CLASS}>
              Complete these steps. Tasma checks them again every 5 seconds.
            </Dialog.Description>
            {readFailedShown && <p className="mt-2 text-sm text-subtle">{READ_FAILED_WORDS}</p>}
            {/* WebKit removes the list role from a list with no list style. */}
            <Accordion.Root<StepId>
              value={panels.open === null ? [] : [panels.open]}
              onValueChange={panels.changeOpen}
              aria-labelledby={titleId}
              render={<ol role="list" className="mt-4" />}
            >
              {steps.map((step) => (
                <SetupStepRow
                  key={step.id}
                  step={step}
                  current={step.id === current?.id}
                  onPressInside={panels.pressInside}
                >
                  <AgentStepContent
                    step={step}
                    check={{ checking: checking === step.id, onCheckAgain: () => void checkAgain(step.id) }}
                    onStop={stopChecking}
                    agent={agent}
                    install={installRun}
                  />
                </SetupStepRow>
              ))}
            </Accordion.Root>
            {setUp && <p id={setUpId} className={DIALOG_STATUS_CLASS}>{setUpWords}</p>}
            {install.isPending && <p className={DIALOG_STATUS_CLASS}>{HOLD_WORDS}</p>}
            <div className={DIALOG_ACTIONS_CLASS}>
              {/* The wait shows in the status line, never in `disabled`. */}
              <button type="button" aria-disabled={install.isPending} onClick={requestClose} className={BUTTON_CLASS}>
                Close
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
