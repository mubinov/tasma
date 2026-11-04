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
import { closeSkillInstallFailure, installSkillOptions } from "../api/mutations";
import { setupQuery } from "../api/queries";
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
} from "../lib/setup-steps";
import { focusDropped } from "../lib/use-focus-lost";
import { skillInstallFailure } from "../lib/write-failure";
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

  const steps = setupSteps({ status, fullAnswered, fullFailed, skillCheckStopped, skillInstall });
  const skillStep = steps.find(({ id }) => id === "skill")!;
  const current = currentStep(steps);
  const stateKey = steps.map(({ state }) => state).join();
  const doneWords = `${String(doneCount(steps))} of ${String(steps.length)}`;

  const [open, setOpen] = useState<StepId | null>(null);
  const [checking, setChecking] = useState<StepId | null>(null);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // The panel that is open is one the user opened, or pressed a control in.
  const byHandRef = useRef(false);
  const stopClosedRef = useRef(false);
  const lastRef = useRef({ steps, fullAnswered, opener: null as StepId | null });
  const holdFocus = useFocusFallback(mainRef, headingRef, current?.id, needed);

  useDocumentTitle("Set up");

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

  const followChange = useEffectEvent(() => {
    const last = lastRef.current;
    const opener = fullAnswered ? current?.id ?? null : null;
    const nowDone = stepsNowDone(last.steps, steps);

    lastRef.current = { steps, fullAnswered, opener };

    // The notice of a failed install sends the user to the install button, which only this state shows.
    if (skillStep.state !== "to-do") {
      closeSkillInstallFailure();
    }
    // The result of an install goes when its step is done, also if the check fails again later.
    if (nowDone.some(({ id }) => id === "skill")) {
      install.reset();
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
    // WebKit does not focus a button on a pointer press, so focus alone does
    // not protect a panel that a mouse user opened.
    if (open !== null && !openLeft && (byHandRef.current || stepOfElement(document.activeElement) === open)) {
      return;
    }

    setOpen(opener);
  });

  useLayoutEffect(() => {
    followChange();
  }, [stateKey, fullAnswered, needed]);

  function changeOpen(value: StepId[]): void {
    const next = value[0] ?? null;

    if (next !== null) {
      byHandRef.current = true;
      setOpen(next);
      return;
    }

    // The current step stays closed when it is the panel the user closed.
    const reopens = byHandRef.current && fullAnswered && current !== undefined && current.id !== open;

    byHandRef.current = false;
    setOpen(reopens ? current.id : null);
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
