import { Accordion } from "@base-ui/react/accordion";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { ChatAgent } from "@tasma/protocol";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { folderDialogAvailable, pickFolder } from "../api/folder-dialog";
import {
  addWorkflowOptions,
  closeSkillInstallFailure,
  createProjectOptions,
  failureKind,
  projectGone,
} from "../api/mutations";
import { projectsQuery } from "../api/queries";
import { screenSkillTexts } from "../lib/agent-texts";
import { attended } from "../lib/attended";
import { useDocumentTitle } from "../lib/document-title";
import { triggerIn } from "../lib/setup-step-elements";
import {
  currentStep,
  doneCount,
  fullReadsFailing,
  hasFullAnswer,
  hasFullFailure,
  installFailedWords,
  installsNothing,
  installStartedWords,
  newestSetup,
  noNpxWords,
  READ_FAILED_WORDS,
  READ_INTERVAL_MS,
  screenNeeded,
  SETUP_PATH,
  setupSteps,
  skillTargets,
  stepInputNow,
  stepsNowDone,
  STILL_CANNOT_CHECK_WORDS,
  type StepId,
  type StepState,
  type WorkflowWriteState,
} from "../lib/setup-steps";
import { useFullSetupRead } from "../lib/use-full-setup-read";
import { useQueryCache } from "../lib/use-query-cache";
import { useSetupFocusFallback } from "../lib/use-setup-focus-fallback";
import { useSkillInstall } from "../lib/use-skill-install";
import { useStepPanels } from "../lib/use-step-panels";
import {
  FOLDER_DIALOG_FAILURE,
  projectAddFailure,
  skillAgentFailure,
  skillInstallFailure,
  workflowAddFailure,
  type SetupFailure,
} from "../lib/write-failure";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { AgentSetupDialog } from "./agent-setup-dialog";
import { ScreenHeading } from "./screen-heading";
import { ScreenStepContent, SetupStepRow, type ScreenStepRuns } from "./setup-step";

const route = getRouteApi(SETUP_PATH);

const CLOSE_DELAY_MS = 1000;

const STOPPED_WORDS = "Tasma does not check for the skill now.";

const COMPLETE_WORDS = "Setup is complete.";

const LIST_FAILED_WORDS = `Tasma cannot read your projects. It tries again every ${String(READ_INTERVAL_MS / 1000)} seconds.`;

const PROJECT_STARTED_WORDS = "Tasma adds the project.";

function workflowStartedWords(project: string): string {
  return `Tasma adds the workflow to ${project}.`;
}

function failureSpoken({ title, line }: SetupFailure): string {
  return `${title} ${line}`;
}

/** A project that step 5 names, and the tag that its write sends. */
type NamedProject = { tag: string; words: string };

/** The agent whose dialog is open, and the control that opened it. */
type OpenDialog = { agent: ChatAgent; opener: HTMLElement };

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

/**
 * Moves focus to the heading at mount. WebKit shows the ring on a script focus with no key press before it, so in
 * that case the heading hides the ring until focus moves to another element of the page. `<main>` takes the blur
 * handler.
 */
function useMountFocus(
  headingRef: RefObject<HTMLHeadingElement | null>,
): { className: string | undefined; onBlur: (event: FocusEvent) => void } {
  const [ringHidden, setRingHidden] = useState(() => !useUiStore.getState().keyPressed);

  useEffect(() => {
    headingRef.current?.focus();
  }, [headingRef]);

  return {
    className: ringHidden ? "focus-visible:outline-none" : undefined,
    onBlur: ({ target }) => {
      // A switch to another app blurs the heading but keeps it the active element.
      if (target === headingRef.current && document.activeElement !== target) {
        setRingHidden(false);
      }
    },
  };
}

/**
 * Calls `onClose` 1 second after the reader is in the window while `closing` is true. A line said while the reader
 * is in another app does not reach them.
 */
function useCloseWhenAttended(closing: boolean, onClose: () => void): void {
  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!closing) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    function startClose(): void {
      if (!attended()) {
        return;
      }

      window.removeEventListener("focus", startClose);
      document.removeEventListener("visibilitychange", startClose);
      timer = setTimeout(() => {
        close();
      }, CLOSE_DELAY_MS);
    }

    window.addEventListener("focus", startClose);
    document.addEventListener("visibilitychange", startClose);
    startClose();

    return () => {
      window.removeEventListener("focus", startClose);
      document.removeEventListener("visibilitychange", startClose);
      clearTimeout(timer);
    };
  }, [closing]);
}

export function SetupScreen(): ReactNode {
  const { queryClient, client } = route.useRouteContext();
  const navigate = useNavigate();
  const skillCheckStopped = useUiStore((state) => state.skillCheckStopped);
  // The route opens the screen only with a status, and setup entries stay in the cache.
  const status = useQueryCache(queryClient, newestSetup)!;
  const fullAnswered = useQueryCache(queryClient, hasFullAnswer);
  const fullFailed = useQueryCache(queryClient, hasFullFailure);
  const readFailing = useQueryCache(queryClient, fullReadsFailing);
  const needed = screenNeeded({ status, fullAnswered, fullFailed, skillCheckStopped });
  // The reads stop when the screen closes.
  const readFailedShown = readFailing && needed;
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  // The route does not wait for this read, because it can take up to 15 seconds. An open dialog polls it.
  const readNow = useFullSetupRead(client, dialog === null);

  // Here and not in the panel, which unmounts when step 3 closes or changes to Done.
  const { install, result, state: skillInstall, runningAgentCount } = useSkillInstall(queryClient, client);

  // Here for the same reason: step 4 changes to Done when its write succeeds.
  const createProject = useMutation(createProjectOptions(queryClient, client));
  const addWorkflow = useMutation(addWorkflowOptions(queryClient, client));
  const [picking, setPicking] = useState(false);
  const [dialogFailed, setDialogFailed] = useState(false);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [created, setCreated] = useState<NamedProject | null>(null);
  const [projectAdded, setProjectAdded] = useState(false);
  const workflowWrite: WorkflowWriteState | undefined = createProject.isPending || addWorkflow.isPending
    ? "running"
    : addWorkflow.isError ? "cannot-add" : undefined;
  const workflowFailure = addWorkflow.error === null ? undefined : workflowAddFailure(addWorkflow.error);

  // From the first status that sees the project, the status alone decides.
  if (projectAdded && status.project === "pass") {
    setProjectAdded(false);
  }

  const steps = setupSteps({
    status,
    fullAnswered,
    fullFailed,
    skillCheckStopped,
    skillInstall,
    projectAdded,
    workflowWrite,
  });
  const skillStep = steps.find(({ id }) => id === "skill")!;
  const workflowStep = steps.find(({ id }) => id === "workflow")!;
  const current = currentStep(steps);
  const stateKey = steps.map(({ state }) => state).join();
  const doneWords = `${String(doneCount(steps))} of ${String(steps.length)}`;
  const targets = skillTargets(status);
  const skillTexts = screenSkillTexts(targets);

  const listRead = workflowStep.state === "to-do" && created === null;
  const projects = useQuery({
    ...projectsQuery(client),
    enabled: listRead,
    refetchInterval: ({ state: { data } }) => (data === undefined || data.data.length === 0 ? READ_INTERVAL_MS : false),
  });
  // The list is sorted by tag.
  const first = listRead ? projects.data?.data[0] : undefined;
  const target = created ?? (first === undefined ? undefined : { tag: first.tag, words: first.name ?? first.tag });
  const listFailing = listRead && target === undefined && projects.isError;

  const [checking, setChecking] = useState<StepId | null>(null);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [main, setMain] = useState<HTMLElement | null>(null);
  const panels = useStepPanels(main, steps, current, fullAnswered);
  const stopClosedRef = useRef(false);
  const lastRef = useRef({ steps, fullAnswered });
  const holdFocus = useSetupFocusFallback(main, headingRef, current?.id, needed && dialog === null);
  const headingFocus = useMountFocus(headingRef);

  useDocumentTitle("Set up");

  useCloseWhenAttended(!needed && dialog === null, () => {
    // The screen unmounts on the move, so the shell says the words after it moves focus.
    useUiStore.getState().setArrivalWords(stopClosedRef.current ? `${STOPPED_WORDS} ${COMPLETE_WORDS}` : COMPLETE_WORDS);
    void navigate({ to: "/tasks", replace: true });
  });

  // An open dialog says what the reads and the steps change.
  const sayHere = useEffectEvent((words: string) => {
    if (dialog === null) {
      announce(words);
    }
  });

  useEffect(() => {
    if (readFailedShown) {
      sayHere(READ_FAILED_WORDS);
    }
  }, [readFailedShown]);

  useEffect(() => {
    if (listFailing) {
      sayHere(LIST_FAILED_WORDS);
    }
  }, [listFailing]);

  const followChange = useEffectEvent(() => {
    const last = lastRef.current;
    const nowDone = stepsNowDone(last.steps, steps);
    const changedToDone = (step: StepId): boolean => nowDone.some(({ id }) => id === step);

    lastRef.current = { steps, fullAnswered };

    // The notice of a failed install sends the user to the install button, which only this state shows.
    if (skillStep.state !== "to-do") {
      closeSkillInstallFailure();
    }
    // The result of a write goes when its step is done, also if the check fails again later.
    if (changedToDone("skill")) {
      install.reset();
    }
    if (changedToDone("project")) {
      // A reset drops the callbacks of a pending create, and its success still starts the workflow write.
      if (!createProject.isPending) {
        createProject.reset();
      }
      setDialogFailed(false);
    }
    if (changedToDone("workflow")) {
      addWorkflow.reset();
    }

    // The change that closes the screen opens nothing and says nothing.
    if (needed) {
      for (const { name } of nowDone) {
        sayHere(`${name}: done.`);
      }
      if (fullAnswered && !last.fullAnswered) {
        const next = current === undefined ? "" : ` Next: ${current.name}.`;

        sayHere(`The check is complete. ${doneWords} steps are done.${next}`);
      }
    }

    panels.follow(needed);
  });

  useLayoutEffect(() => {
    followChange();
  }, [stateKey, fullAnswered, needed]);

  const revealRef = useRef(false);

  /** Opens step 5 to show the failure, unless another panel is kept open. */
  const showWorkflowFailure = useEffectEvent(() => {
    if (workflowFailure === undefined) {
      return;
    }

    const failure = failureSpoken(workflowFailure);

    // After `project-not-found`, step 4 can be back in its start state, and step 5 then shows no failure.
    if (workflowStep.state !== "to-do") {
      announce(failure);
      return;
    }

    const shown = panels.openNow();
    const kept = shown !== "workflow" && panels.kept(shown);
    const step = String(workflowStep.number);

    if (kept) {
      announce(`${failure} Open step ${step} to read the reason and to try again.`);
      return;
    }
    if (shown !== "workflow") {
      revealRef.current = true;
      panels.showByHand("workflow");
    }
    announce(`${failure} Step ${step} shows the reason and a Try again button.`);
  });

  useLayoutEffect(() => {
    showWorkflowFailure();
  }, [addWorkflow.error]);

  useEffect(() => {
    if (panels.open === "workflow" && revealRef.current) {
      revealRef.current = false;
      main!.querySelector("[data-setup-step=\"workflow\"]")!.scrollIntoView({ block: "nearest" });
    }
  }, [panels.open, main]);

  function stateNow(step: StepId): StepState | undefined {
    return setupSteps(stepInputNow(queryClient)).find(({ id }) => id === step)?.state;
  }

  async function checkAgain(step: StepId): Promise<void> {
    if (checking !== null) {
      return;
    }

    setChecking(step);
    const answer = await readNow();
    setChecking(null);

    const state = stateNow(step);

    if (screenNeeded(stepInputNow(queryClient)) && (answer.isError || state === "cannot-check" || state === "not-run")) {
      announce(STILL_CANNOT_CHECK_WORDS);
    }
  }

  function startInstall(): void {
    if (skillInstall === "running") {
      return;
    }

    const offered = (): boolean => stateNow("skill") === "to-do";

    announce(installStartedWords(targets.length));
    const failure = skillInstallFailure(skillTexts.button);
    const write = { agents: targets, failure, offered, agentFailure: skillAgentFailure };

    install.mutate(write, {
      onSuccess: (answer) => {
        if (installsNothing(answer) && offered()) {
          announce(answer.result === "npx-missing" ? noNpxWords(skillStep.number) : installFailedWords(skillStep.number));
        }
      },
    });
  }

  function startWorkflow(project: NamedProject): void {
    announce(workflowStartedWords(project.words));
    addWorkflow.mutate({ tag: project.tag }, {
      onError: (error) => {
        // A terminal command removed or renamed the project, so the status and the list decide the next try.
        if (projectGone(error)) {
          setCreated(null);
          setProjectAdded(false);
        }
      },
    });
  }

  function addProject(path: string): void {
    setPickedPath(path);
    announce(PROJECT_STARTED_WORDS);
    createProject.mutate({ path }, {
      onSuccess: ({ tag, name }) => {
        const project = { tag, words: name ?? tag };

        setCreated(project);
        setProjectAdded(true);
        startWorkflow(project);
      },
      onError: (error) => {
        // A status read can see the project before the answer of its create fails.
        if (stateNow("project") === "done") {
          createProject.reset();
          return;
        }

        announce(failureSpoken(projectAddFailure(error)));
      },
    });
  }

  const createError = createProject.error;
  // The folder is not at fault, so the same path goes again.
  const retryPath = createError !== null && failureKind(createError.cause) !== "refused";
  let projectFailure: SetupFailure | undefined;

  if (dialogFailed) {
    projectFailure = FOLDER_DIALOG_FAILURE;
  } else if (createError !== null) {
    projectFailure = projectAddFailure(createError);
  }

  async function chooseFolder(): Promise<void> {
    setDialogFailed(false);
    createProject.reset();
    addWorkflow.reset();
    setPicking(true);

    let path: string | null;

    try {
      path = await pickFolder();
    } catch {
      setPicking(false);
      setDialogFailed(true);
      announce(failureSpoken(FOLDER_DIALOG_FAILURE));
      return;
    }

    setPicking(false);
    if (path !== null) {
      addProject(path);
    }
  }

  function pressProject(): void {
    if (picking || createProject.isPending) {
      return;
    }
    if (retryPath) {
      // A failed write always comes after `addProject`, which stored its path.
      addProject(pickedPath!);
      return;
    }

    void chooseFolder();
  }

  function pressAddWorkflow(): void {
    if (workflowWrite !== "running" && target !== undefined) {
      startWorkflow(target);
    }
  }

  function stopChecking(): void {
    useUiStore.getState().setSkillCheckStopped(true);

    if (screenNeeded(stepInputNow(queryClient))) {
      announce(STOPPED_WORDS);
    } else {
      stopClosedRef.current = true;
    }
  }

  const runs: ScreenStepRuns = {
    agents: {
      entries: fullAnswered ? status.agents : undefined,
      onSetUp: (agent, opener) => {
        setDialog({ agent, opener });
      },
    },
    install: {
      state: skillInstall,
      result,
      runningAgentCount,
      texts: skillTexts,
      failure: undefined,
      onInstall: startInstall,
    },
    project: {
      dialog: folderDialogAvailable(),
      picking,
      adding: createProject.isPending,
      failure: projectFailure,
      retry: retryPath,
      path: pickedPath ?? "",
      onPress: pressProject,
      onAdd: addProject,
    },
    workflow: {
      project: target?.words,
      listFailure: listFailing ? LIST_FAILED_WORDS : undefined,
      running: workflowWrite === "running",
      failure: workflowFailure,
      onAdd: pressAddWorkflow,
    },
  };

  return (
    <>
      <main
        ref={setMain}
        tabIndex={-1}
        onFocus={holdFocus}
        onBlur={headingFocus.onBlur}
        className="grid flex-1 grid-cols-[minmax(0,37rem)] content-start items-start justify-center gap-y-8 px-6 pt-[calc(clamp(1.5rem,11vh,6.5rem)+var(--title-band))] pb-[calc(--spacing(18)+var(--notice-stack-height,0px))] min-[58rem]:grid-cols-[minmax(15rem,19rem)_minmax(0,37rem)] min-[58rem]:gap-x-24 min-[58rem]:px-10"
      >
        <div className="min-[58rem]:sticky min-[58rem]:top-[calc(--spacing(12)+var(--title-band))]">
          <ScreenHeading ref={headingRef} id={headingId} tabIndex={-1} className={headingFocus.className}>
            Set up Tasma
          </ScreenHeading>
          <p className="mt-2.5 text-base text-subtle">Complete these steps to run your first task.</p>
          <p className="mt-6 font-chrome text-base font-medium">{`${doneWords} done`}</p>
          {readFailedShown && <p className="mt-2 text-sm text-subtle">{READ_FAILED_WORDS}</p>}
        </div>
        {/* WebKit removes the list role from a list with no list style. */}
        <Accordion.Root<StepId>
          value={panels.open === null ? [] : [panels.open]}
          onValueChange={panels.changeOpen}
          aria-labelledby={headingId}
          render={<ol role="list" />}
        >
          {steps.map((step) => (
            <SetupStepRow
              key={step.id}
              step={step}
              current={step.id === current?.id}
              onPressInside={panels.pressInside}
            >
              <ScreenStepContent
                step={step}
                check={{ checking: checking === step.id, onCheckAgain: () => void checkAgain(step.id) }}
                onStop={stopChecking}
                runs={runs}
              />
            </SetupStepRow>
          ))}
        </Accordion.Root>
      </main>
      {/* Outside <main>, whose focus handlers would hear the focus events of the dialog through the portal. */}
      {dialog !== null && (
        <AgentSetupDialog
          agent={dialog.agent}
          opener={dialog.opener}
          focusFallback={() => {
            const heading = headingRef.current;

            // Null while the screen unmounts, which unmounts the dialog with it.
            if (heading !== null) {
              (triggerIn(main!, current?.id) ?? heading).focus();
            }
          }}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
