import { Accordion } from "@base-ui/react/accordion";
import { keepPreviousData, notifyManager, useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
  installSkillOptions,
  projectGone,
} from "../api/mutations";
import { projectsQuery, setupQuery } from "../api/queries";
import { useDocumentTitle } from "../lib/document-title";
import {
  currentStep,
  doneCount,
  fullReadsFailing,
  hasFullAnswer,
  hasFullFailure,
  newestSetup,
  SETUP_PATH,
  setupNeeded,
  setupSteps,
  stepsNowDone,
  type SkillInstallState,
  type StepId,
  type StepState,
  type WorkflowWriteState,
} from "../lib/setup-steps";
import { focusDropped } from "../lib/use-focus-lost";
import {
  FOLDER_DIALOG_FAILURE,
  projectAddFailure,
  skillInstallFailure,
  workflowAddFailure,
  type SetupFailure,
} from "../lib/write-failure";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { ScreenHeading } from "./screen-heading";
import { SetupStepRow } from "./setup-step";

const route = getRouteApi(SETUP_PATH);

const READ_INTERVAL_MS = 5000;

const CLOSE_DELAY_MS = 1000;

const STOPPED_WORDS = "Tasma does not check for the skill now.";

const COMPLETE_WORDS = "Setup is complete.";

const READ_FAILED_WORDS = `Tasma cannot check the steps now. It tries again every ${String(READ_INTERVAL_MS / 1000)} seconds.`;

const STILL_CANNOT_CHECK_WORDS = "Tasma still cannot check this.";

const INSTALL_STARTED_WORDS = "Install in progress. This can take up to 2 minutes.";

function installFailedWords(step: number): string {
  return `Tasma cannot install the skill. The output is in step ${String(step)}, above the Try again button.`;
}

function noNpxWords(step: number): string {
  return `Tasma cannot find npx. The plugin commands are in step ${String(step)}, above the Try again button.`;
}

const LIST_FAILED_WORDS = `Tasma cannot read your projects. It tries again every ${String(READ_INTERVAL_MS / 1000)} seconds.`;

const PROJECT_STARTED_WORDS = "Tasma adds the project.";

function workflowStartedWords(project: string): string {
  return `Tasma adds the workflow to ${project}.`;
}

function failureSpoken({ title, line }: SetupFailure): string {
  return `${title} ${line}`;
}

/** A project that step 6 names, and the tag that its write sends. */
type NamedProject = { tag: string; words: string };

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

function useQueryCache<T>(queryClient: QueryClient, read: (queryClient: QueryClient) => T): T {
  return useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    () => read(queryClient),
  );
}

function stepOfElement(element: Element | null): StepId | null {
  return (element?.closest<HTMLElement>("[data-setup-step]")?.dataset.setupStep ?? null) as StepId | null;
}

/**
 * A panel that the user opened, or that holds focus, stays open. WebKit does not focus a button on a
 * pointer press, so focus alone does not protect a panel that a mouse user opened.
 */
function keptOpen(step: StepId | null, byHand: boolean): boolean {
  return step !== null && (byHand || stepOfElement(document.activeElement) === step);
}

/**
 * The element that held focus, and its step. Focus drops to <body> when the
 * element leaves the page, and by then the element no longer names its step.
 */
type HeldFocus = { element: Element; step: StepId | null };

function useFocusFallback(
  mainRef: RefObject<HTMLElement | null>,
  headingRef: RefObject<HTMLHeadingElement | null>,
  current: StepId | undefined,
  active: boolean,
): (event: FocusEvent) => void {
  const heldRef = useRef<HeldFocus | null>(null);

  const restoreFocus = useEffectEvent(() => {
    const held = heldRef.current;

    if (held === null || held.element.isConnected || !focusDropped() || !active) {
      return;
    }

    const main = mainRef.current!;
    const triggerOf = (step: StepId | null | undefined): HTMLElement | null =>
      main.querySelector<HTMLElement>(`[data-setup-step="${String(step)}"] [data-setup-trigger]`);

    (triggerOf(held.step) ?? triggerOf(current) ?? headingRef.current!).focus();
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      restoreFocus();
    });

    observer.observe(mainRef.current!, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [mainRef]);

  return ({ target }) => {
    heldRef.current = { element: target, step: stepOfElement(target) };
  };
}

export function SetupScreen(): ReactNode {
  const { queryClient, client } = route.useRouteContext();
  const navigate = useNavigate();
  const skillCheckStopped = useUiStore((state) => state.skillCheckStopped);
  const status = useQueryCache(queryClient, newestSetup);
  const fullAnswered = useQueryCache(queryClient, hasFullAnswer);
  const fullFailed = useQueryCache(queryClient, hasFullFailure);
  const readFailing = useQueryCache(queryClient, fullReadsFailing);
  const needed = setupNeeded(status, skillCheckStopped);

  // The route does not wait for this read, because it can take up to 15 seconds.
  const full = useQuery({
    ...setupQuery(client, skillCheckStopped ? { mode: "full", skipSkill: true } : { mode: "full" }),
    refetchInterval: READ_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });

  // Here and not in the panel, which unmounts when step 4 closes or changes to Done.
  const install = useMutation(installSkillOptions(queryClient, client));
  const cannotInstall = install.data?.result === "failed" || install.data?.result === "npx-missing";
  const skillInstall: SkillInstallState | undefined = install.isPending ? "running" : cannotInstall ? "cannot-install" : undefined;

  // Here for the same reason: step 5 changes to Done when its write succeeds.
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
  if (projectAdded && status?.project === "pass") {
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

  const [open, setOpen] = useState<StepId | null>(null);
  // Two effects of one commit can each open a panel, and the second needs what the first chose.
  const openNowRef = useRef<StepId | null>(null);
  const [checking, setChecking] = useState<StepId | null>(null);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // The panel that is open is one the user opened or pressed a control in, or step 6 opened to show a failure.
  const byHandRef = useRef(false);
  const stopClosedRef = useRef(false);
  const lastRef = useRef({ steps, fullAnswered, opener: null as StepId | null });
  const holdFocus = useFocusFallback(mainRef, headingRef, current?.id, needed);

  useDocumentTitle("Set up");

  function showStep(step: StepId | null): void {
    openNowRef.current = step;
    setOpen(step);
  }

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const readAgain = useEffectEvent(() => {
    void full.refetch({ cancelRefetch: false });
  });

  // The library itself reacts only to `visibilitychange`, and a switch to
  // another app usually leaves the window visible.
  useEffect(() => {
    function onFocus(): void {
      readAgain();
    }

    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const close = useEffectEvent(() => {
    // The screen unmounts on the move, so the shell says the words after it moves focus.
    useUiStore.getState().setArrivalWords(stopClosedRef.current ? `${STOPPED_WORDS} ${COMPLETE_WORDS}` : COMPLETE_WORDS);
    void navigate({ to: "/tasks", replace: true });
  });

  useEffect(() => {
    if (needed) {
      return;
    }

    const timer = setTimeout(() => {
      close();
    }, CLOSE_DELAY_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [needed]);

  useEffect(() => {
    if (readFailing) {
      announce(READ_FAILED_WORDS);
    }
  }, [readFailing]);

  useEffect(() => {
    if (listFailing) {
      announce(LIST_FAILED_WORDS);
    }
  }, [listFailing]);

  const followChange = useEffectEvent(() => {
    const last = lastRef.current;
    const opener = fullAnswered ? current?.id ?? null : null;
    const nowDone = stepsNowDone(last.steps, steps);
    const changedToDone = (step: StepId): boolean => nowDone.some(({ id }) => id === step);

    lastRef.current = { steps, fullAnswered, opener };

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
    if (!needed) {
      return;
    }

    for (const { name } of nowDone) {
      announce(`${name}: done.`);
    }
    if (fullAnswered && !last.fullAnswered) {
      const next = current === undefined ? "" : ` Next: ${current.name}.`;

      announce(`The check is complete. ${doneWords} steps are done.${next}`);
    }

    const openStep = steps.find(({ id }) => id === open);
    const openLeft = openStep !== undefined && !openStep.canOpen;

    if (openLeft) {
      byHandRef.current = false;
    }
    if (opener === last.opener && !openLeft) {
      return;
    }
    if (!openLeft && keptOpen(open, byHandRef.current)) {
      return;
    }

    showStep(opener);
  });

  useLayoutEffect(() => {
    followChange();
  }, [stateKey, fullAnswered, needed]);

  const revealRef = useRef(false);

  /** Opens step 6 to show the failure, unless another panel is kept open. */
  const showWorkflowFailure = useEffectEvent(() => {
    if (workflowFailure === undefined) {
      return;
    }

    const failure = failureSpoken(workflowFailure);

    // After `project-not-found`, step 5 can be back in its start state, and step 6 then shows no failure.
    if (workflowStep.state !== "to-do") {
      announce(failure);
      return;
    }

    const shown = openNowRef.current;
    const kept = shown !== "workflow" && keptOpen(shown, byHandRef.current);
    const step = String(workflowStep.number);

    if (kept) {
      announce(`${failure} Open step ${step} to read the reason and to try again.`);
      return;
    }
    if (shown !== "workflow") {
      byHandRef.current = true;
      revealRef.current = true;
      showStep("workflow");
    }
    announce(`${failure} Step ${step} shows the reason and a Try again button.`);
  });

  useLayoutEffect(() => {
    showWorkflowFailure();
  }, [addWorkflow.error]);

  useEffect(() => {
    if (open === "workflow" && revealRef.current) {
      revealRef.current = false;
      mainRef.current!.querySelector("[data-setup-step=\"workflow\"]")!.scrollIntoView({ block: "nearest" });
    }
  }, [open]);

  function changeOpen(value: StepId[]): void {
    const next = value[0] ?? null;

    if (next !== null) {
      byHandRef.current = true;
      showStep(next);
      return;
    }

    // The current step stays closed when it is the panel the user closed.
    const reopens = byHandRef.current && fullAnswered && current !== undefined && current.id !== open;

    byHandRef.current = false;
    showStep(reopens ? current.id : null);
  }

  /** A render holds the state of the answers before it, and an end of a read or a write needs the newest. */
  function stateNow(step: StepId): StepState | undefined {
    return setupSteps({
      status: newestSetup(queryClient),
      fullAnswered: hasFullAnswer(queryClient),
      fullFailed: hasFullFailure(queryClient),
      skillCheckStopped: useUiStore.getState().skillCheckStopped,
    }).find(({ id }) => id === step)?.state;
  }

  async function checkAgain(step: StepId): Promise<void> {
    if (checking !== null) {
      return;
    }

    setChecking(step);
    const result = await full.refetch({ cancelRefetch: false });
    setChecking(null);

    const state = stateNow(step);

    if (
      setupNeeded(newestSetup(queryClient), useUiStore.getState().skillCheckStopped)
      && (result.isError || state === "cannot-check" || state === "not-run")
    ) {
      announce(STILL_CANNOT_CHECK_WORDS);
    }
  }

  function startInstall(): void {
    if (install.isPending) {
      return;
    }

    const offered = (): boolean => stateNow("skill") === "to-do";

    announce(INSTALL_STARTED_WORDS);
    install.mutate({ failure: skillInstallFailure(), offered }, {
      onSuccess: ({ result }) => {
        if (!offered()) {
          return;
        }
        if (result === "failed") {
          announce(installFailedWords(skillStep.number));
        } else if (result === "npx-missing") {
          announce(noNpxWords(skillStep.number));
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

    if (setupNeeded(newestSetup(queryClient), true)) {
      announce(STOPPED_WORDS);
    } else {
      stopClosedRef.current = true;
    }
  }

  return (
    <>
      <header className="flex items-center px-6 pt-[calc(--spacing(5)+var(--title-band))] min-[58rem]:px-10">
        <div className="flex min-h-8 items-center gap-2.5 font-chrome text-lg font-semibold">
          <span className="size-6 rounded-control bg-graphic" />
          tasma
        </div>
      </header>
      <main
        ref={mainRef}
        tabIndex={-1}
        onFocus={holdFocus}
        className="grid flex-1 grid-cols-[minmax(0,37rem)] content-start items-start justify-center gap-y-8 px-6 pt-[clamp(1.5rem,11vh,6.5rem)] pb-[calc(--spacing(18)+var(--notice-stack-height,0px))] min-[58rem]:grid-cols-[minmax(15rem,19rem)_minmax(0,37rem)] min-[58rem]:gap-x-24 min-[58rem]:px-10"
      >
        <div className="min-[58rem]:sticky min-[58rem]:top-[calc(--spacing(12)+var(--title-band))]">
          <ScreenHeading ref={headingRef} id={headingId} tabIndex={-1}>
            Set up Tasma
          </ScreenHeading>
          <p className="mt-2.5 text-base text-subtle">Complete these steps to run your first task.</p>
          <p className="mt-6 font-chrome text-base font-medium">{`${doneWords} done`}</p>
          {readFailing && <p className="mt-2 text-sm text-subtle">{READ_FAILED_WORDS}</p>}
        </div>
        {/* WebKit removes the list role from a list with no list style. */}
        <Accordion.Root<StepId>
          value={open === null ? [] : [open]}
          onValueChange={changeOpen}
          aria-labelledby={headingId}
          render={<ol role="list" />}
        >
          {steps.map((step) => (
            <SetupStepRow
              key={step.id}
              step={step}
              current={step.id === current?.id}
              checking={checking === step.id}
              onCheckAgain={() => void checkAgain(step.id)}
              onStop={stopChecking}
              install={{ state: skillInstall, answer: install.data, onInstall: startInstall }}
              project={{
                dialog: folderDialogAvailable(),
                picking,
                adding: createProject.isPending,
                failure: projectFailure,
                retry: retryPath,
                path: pickedPath ?? "",
                onPress: pressProject,
                onAdd: addProject,
              }}
              workflow={{
                project: target?.words,
                listFailure: listFailing ? LIST_FAILED_WORDS : undefined,
                running: workflowWrite === "running",
                failure: workflowFailure,
                onAdd: pressAddWorkflow,
              }}
              onPressInside={() => {
                byHandRef.current = true;
              }}
            />
          ))}
        </Accordion.Root>
      </main>
    </>
  );
}
