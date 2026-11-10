import { Accordion } from "@base-ui/react/accordion";
import { Button } from "@base-ui/react/button";
import { Field } from "@base-ui/react/field";
import type { SkillInstall } from "@tasma/protocol";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { CaretDownIcon, CheckIcon, CircleNotchIcon } from "../lib/icons";
import { isChangeToDone, type SetupStep, type SkillInstallState, type StepState } from "../lib/setup-steps";
import type { SetupFailure } from "../lib/write-failure";
import { useNoticeStore } from "../store/notices";
import { BUTTON_CLASS, BUTTON_FILLED_CLASS, FIELD_BORDER_CLASS, FIELD_ERROR_CLASS } from "./control-classes";

const INSTALL_GUIDE_URL = "https://code.claude.com/docs/en/setup";
const SKILL_INSTALL_URL = "https://github.com/mubinov/tasma-skill#install";

const COPY_WORDS_MS = 1500;

/** The row is the box of the line that runs through the marks. */
const ROW_CLASS = "relative before:absolute before:inset-y-0 before:left-[calc(--spacing(3)-1px)] before:w-0.5 before:bg-line first:before:top-6 last:before:bottom-auto last:before:h-6";

const HEAD_CLASS = "relative grid w-full grid-cols-[--spacing(6)_minmax(0,1fr)_auto] items-start gap-x-4 rounded-control py-3 text-left";

const MARK_CLASS = "relative grid size-6 place-items-center rounded-full border-[1.5px] font-chrome text-xs-plus";

const WHY_CLASS = "max-w-lg text-base text-subtle";

const RUN_CLASS = "mt-3.5 max-w-lg text-sm text-subtle";

const ACTIONS_CLASS = "mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2";

const PROBLEM_CLASS = "mt-3.5 max-w-lg text-sm font-medium text-text";

const PATH_CLASS = `mt-1 h-8 w-full rounded-control bg-bg px-2.5 text-sm text-text placeholder:text-dim ${FIELD_BORDER_CLASS}`;

const EMPTY_PATH_WORDS = "Type the path of a folder.";

function markLook(state: StepState, current: boolean, settling: boolean): string {
  if (state === "done") {
    return `border-done bg-bg text-done ${settling ? "animate-step-done motion-reduce:animate-none" : ""}`;
  }
  if (current) {
    return "border-signal bg-signal font-semibold text-bg";
  }

  return `border-graphic bg-bg font-medium text-subtle ${state === "stopped" ? "border-dashed" : ""}`;
}

function Mark({ step, current, settling }: { step: SetupStep; current: boolean; settling: boolean }): ReactNode {
  let content: ReactNode = step.number;

  if (step.state === "done") {
    content = <CheckIcon size={14} weight="bold" />;
  } else if (step.state === "in-progress") {
    content = <CircleNotchIcon size={14} className="animate-spin motion-reduce:animate-none" />;
  }

  return <span aria-hidden="true" className={`${MARK_CLASS} ${markLook(step.state, current, settling)}`}>{content}</span>;
}

function StepHead({ step, current, settling }: { step: SetupStep; current: boolean; settling: boolean }): ReactNode {
  const labelColor = current && step.labelIsOwner && step.owner === "you" ? "text-signal" : "text-dim";

  return (
    <>
      <Mark step={step} current={current} settling={settling} />
      <span className={`font-chrome text-base/6 font-medium group-hover:underline group-data-[panel-open]:text-lg group-data-[panel-open]:font-semibold ${step.state === "done" ? "text-subtle" : ""}`}>
        {step.name}
      </span>
      <span className={`inline-flex items-center gap-2 text-sm/6 whitespace-nowrap ${labelColor}`}>
        {step.label}
        <CaretDownIcon size={12} aria-hidden="true" className={step.canOpen ? "text-dim group-data-[panel-open]:rotate-180" : "invisible"} />
      </span>
    </>
  );
}

type ExternalLinkProps = { href: string; className: string; children: ReactNode };

function ExternalLink({ href, className, children }: ExternalLinkProps): ReactNode {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
      {" "}
      <span className="sr-only">(opens in the browser)</span>
    </a>
  );
}

type CopyResult = "none" | "copied" | "failed";

const COPY_WORDS: Record<CopyResult, string> = { none: "Copy", copied: "Copied", failed: "Cannot copy" };

/** What the words of a failed copy call the text. */
type CopyNoun = "command" | "output" | "path" | "address";

type CopyButtonProps = {
  text: string;
  /** The element that holds the text, which a failed copy selects. */
  holder: RefObject<HTMLElement | null>;
  noun: CopyNoun;
  describedBy: string;
};

function CopyButton({ text, holder, noun, describedBy }: CopyButtonProps): ReactNode {
  const [result, setResult] = useState<CopyResult>("none");
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => {
    clearTimeout(timerRef.current);
  }, []);

  function showResult(next: CopyResult): void {
    setResult(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setResult("none");
    }, COPY_WORDS_MS);
  }

  async function copy(): Promise<void> {
    const { announce } = useNoticeStore.getState();

    try {
      await navigator.clipboard.writeText(text);
      showResult("copied");
      announce("Copied");
    } catch {
      window.getSelection()?.selectAllChildren(holder.current!);
      showResult("failed");
      announce(`Cannot copy. The ${noun} is selected. Press Command-C to copy it.`);
    }
  }

  return (
    <Button
      type="button"
      aria-describedby={describedBy}
      onClick={() => void copy()}
      className="inline-flex min-h-7 shrink-0 items-center rounded-control border border-line bg-bg px-2.5 text-xs-plus text-text hover:border-graphic"
    >
      {COPY_WORDS[result]}
    </Button>
  );
}

/**
 * Generated content, so a selection or a copy of the command holds no number,
 * and a screen reader still reads it. Full literals, for the Tailwind scanner.
 */
const NUMBER_CLASSES = {
  1: "before:font-mono before:text-xs-plus before:text-dim before:content-['1']",
  2: "before:font-mono before:text-xs-plus before:text-dim before:content-['2']",
} as const;

type CommandBoxProps = {
  command: string;
  noun?: CopyNoun;
  /** The id of the `<code>`, for a control that the box describes. */
  codeId?: string;
  /** The place of the command in a numbered list. */
  number?: keyof typeof NUMBER_CLASSES;
};

function CommandBox({ command, noun = "command", codeId, number }: CommandBoxProps): ReactNode {
  const codeRef = useRef<HTMLElement>(null);
  const ownId = useId();
  const id = codeId ?? ownId;

  return (
    <div className={`mt-1.5 flex w-full max-w-lg items-center gap-3 rounded-control bg-surface-2 py-1.5 pr-1.5 pl-3 ${number === undefined ? "" : NUMBER_CLASSES[number]}`}>
      <code ref={codeRef} id={id} className="flex-1 font-mono text-xs-plus wrap-anywhere">{command}</code>
      <CopyButton text={command} holder={codeRef} noun={noun} describedBy={id} />
    </div>
  );
}

function RunCommand({ command }: { command: string }): ReactNode {
  return (
    <>
      <p className={RUN_CLASS}>Run this command in a terminal:</p>
      <CommandBox command={command} />
    </>
  );
}

function InstallOutput({ output }: { output: string }): ReactNode {
  const outputRef = useRef<HTMLPreElement>(null);
  const lineId = useId();

  return (
    <>
      <p id={lineId} className={PROBLEM_CLASS}>Tasma cannot install the skill. The command gave this output:</p>
      <div className="mt-1.5 flex w-full max-w-lg items-start gap-3 rounded-control bg-surface-2 py-1.5 pr-1.5 pl-3">
        <pre
          ref={outputRef}
          tabIndex={0}
          role="group"
          aria-labelledby={lineId}
          className="max-h-36 min-w-0 flex-1 overflow-auto rounded-control py-0.5 font-mono text-xs-plus whitespace-pre-wrap wrap-anywhere text-subtle"
        >
          {output}
        </pre>
        <CopyButton text={output} holder={outputRef} noun="output" describedBy={lineId} />
      </div>
    </>
  );
}

function NoNpx(): ReactNode {
  return (
    <>
      <p className={PROBLEM_CLASS}>
        Tasma cannot find
        {" "}
        <code className="font-mono text-xs-plus">npx</code>
        , which comes with Node.js.
      </p>
      <p className={RUN_CLASS}>To install the skill as a Claude Code plugin, run these commands in Claude Code:</p>
      {/* WebKit removes the list role from a list with no list style. */}
      <ol role="list">
        <li><CommandBox command="/plugin marketplace add mubinov/tasma-skill" number={1} /></li>
        <li><CommandBox command="/plugin install tasma@tasma" number={2} /></li>
      </ol>
      <p className={RUN_CLASS}>Or install Node.js, and then select &quot;Try again&quot;.</p>
    </>
  );
}

function Spinner(): ReactNode {
  return <CircleNotchIcon size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
}

/** What step 4 shows of the write that lives in the screen. */
type SkillInstallRun = {
  state: SkillInstallState | undefined;
  answer: SkillInstall | undefined;
  onInstall: () => void;
};

const INSTALL_WORDS: Record<SkillInstallState, string> = { "running": "Install in progress", "cannot-install": "Try again" };

function SkillContent({ install, onStop }: { install: SkillInstallRun; onStop: () => void }): ReactNode {
  const { state, answer, onInstall } = install;
  const running = state === "running";
  const warningId = useId();
  const descriptionId = useId();

  return (
    <>
      <p className={WHY_CLASS}>Claude Code needs this skill to run workflow steps.</p>
      {answer?.result === "failed" && <InstallOutput output={answer.output} />}
      {answer?.result === "npx-missing" && <NoNpx />}
      <div className={ACTIONS_CLASS}>
        {/* One element in all states, and aria-disabled: `disabled` would drop the focus resting here. */}
        <Button
          type="button"
          aria-disabled={running}
          aria-describedby={warningId}
          onClick={onInstall}
          className={answer?.result === "npx-missing" ? BUTTON_CLASS : BUTTON_FILLED_CLASS}
        >
          {running && <Spinner />}
          {state === undefined ? "Install in Claude Code" : INSTALL_WORDS[state]}
        </Button>
        <ExternalLink href={SKILL_INSTALL_URL} className="text-sm text-subtle underline underline-offset-2 hover:text-text">
          Other ways to install the skill
        </ExternalLink>
      </div>
      {running && <p className={RUN_CLASS}>Tasma downloads the skill from GitHub. This can take up to 2 minutes.</p>}
      <p id={descriptionId} className={RUN_CLASS}>
        <span id={warningId}>
          If the skill is already in a different folder, Tasma cannot find it, and a second install makes Claude Code
          load two copies.
        </span>
        {" "}
        In that case, stop the check. Tasma then does not check for the skill again, also after a restart.
      </p>
      <div className="mt-2">
        <Button type="button" aria-describedby={descriptionId} onClick={onStop} className={BUTTON_CLASS}>
          Stop checking for the skill
        </Button>
      </div>
    </>
  );
}

function CheckAgain({ checking, onCheckAgain }: { checking: boolean; onCheckAgain: () => void }): ReactNode {
  return (
    <>
      <p className={WHY_CLASS}>Tasma cannot check this now.</p>
      <div className={ACTIONS_CLASS}>
        {/* The wait is in the label and in aria-disabled: `disabled` would drop the focus resting here. */}
        <Button
          type="button"
          aria-disabled={checking}
          onClick={onCheckAgain}
          className={BUTTON_FILLED_CLASS}
        >
          {checking ? "Check in progress" : "Check again"}
        </Button>
      </div>
    </>
  );
}

type FailureIds = { title: string; line: string; box: string };

function useFailureIds(): FailureIds {
  return { title: useId(), line: useId(), box: useId() };
}

/** The ids of the words of a failure block: the Copy button is left out. */
function failureWordIds(failure: SetupFailure | undefined, ids: FailureIds): string[] {
  if (failure === undefined) {
    return [];
  }

  return failure.box === undefined ? [ids.title, ids.line] : [ids.title, ids.line, ids.box];
}

function idRefs(ids: readonly string[]): string | undefined {
  return ids.length === 0 ? undefined : ids.join(" ");
}

/** Not a live region: the screen announces the failure. */
function FailureBlock({ failure, ids }: { failure: SetupFailure; ids: FailureIds }): ReactNode {
  return (
    <div className="mt-3.5 w-full max-w-lg">
      <p id={ids.title} className="text-base font-medium text-signal">{failure.title}</p>
      <p id={ids.line} className="mt-0.5 text-sm text-subtle wrap-anywhere">{failure.line}</p>
      {failure.box !== undefined && <CommandBox command={failure.box.text} noun={failure.box.noun} codeId={ids.box} />}
    </div>
  );
}

/** What step 5 shows of the pick and the write that live in the screen. */
type ProjectStepRun = {
  /** The macOS app offers the folder dialog. The browser shows a path field. */
  dialog: boolean;
  picking: boolean;
  adding: boolean;
  failure: SetupFailure | undefined;
  /** The last failure was not about the folder, so the button sends the same path again. */
  retry: boolean;
  /** The path of the last try, which the field starts with. */
  path: string;
  /** Opens the dialog, or sends the path again when `retry` is true. */
  onPress: () => void;
  /** Sends the path of the field. */
  onAdd: (path: string) => void;
};

function ChooseFolder({ run, failureIds }: { run: ProjectStepRun; failureIds: string[] }): ReactNode {
  const busy = run.picking || run.adding;
  let words = run.retry ? "Try again" : "Choose folder";

  if (run.adding) {
    words = "Adding project";
  }

  return (
    <div className={ACTIONS_CLASS}>
      <Button
        type="button"
        aria-disabled={busy}
        aria-describedby={idRefs(failureIds)}
        onClick={run.onPress}
        className={BUTTON_FILLED_CLASS}
      >
        {busy && <Spinner />}
        {words}
      </Button>
    </div>
  );
}

function PathForm({ run, failureIds }: { run: ProjectStepRun; failureIds: string[] }): ReactNode {
  const [value, setValue] = useState(run.path);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(): void {
    if (run.adding) {
      return;
    }

    const path = value.trim();

    if (path === "") {
      // `Field.Error` is not a live region: a caret already in the field hears
      // the words only when they are spoken. The focus move reads them otherwise.
      const inField = document.activeElement === inputRef.current;

      setError(EMPTY_PATH_WORDS);
      inputRef.current!.focus();
      if (inField) {
        useNoticeStore.getState().announce(EMPTY_PATH_WORDS);
      }
      return;
    }

    run.onAdd(path);
  }

  return (
    <form
      className="mt-3.5 w-full max-w-lg"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field.Root name="path" invalid={error !== undefined}>
        <Field.Label className="font-chrome text-sm font-medium text-text">Folder path</Field.Label>
        <Field.Control
          ref={inputRef}
          aria-required="true"
          placeholder="Required"
          value={value}
          onValueChange={(next) => {
            setValue(next);
            setError(undefined);
          }}
          className={PATH_CLASS}
        />
        {error !== undefined && <Field.Error match className={FIELD_ERROR_CLASS}>{error}</Field.Error>}
      </Field.Root>
      <div className={ACTIONS_CLASS}>
        <Button
          type="submit"
          aria-disabled={run.adding}
          aria-describedby={idRefs(failureIds)}
          className={BUTTON_FILLED_CLASS}
        >
          {run.adding && <Spinner />}
          {run.adding ? "Adding project" : "Add project"}
        </Button>
      </div>
    </form>
  );
}

function ProjectContent({ run }: { run: ProjectStepRun }): ReactNode {
  const ids = useFailureIds();
  const failureIds = failureWordIds(run.failure, ids);

  return (
    <>
      <p className={WHY_CLASS}>Choose the folder with your code. Claude Code works in this folder.</p>
      {run.failure !== undefined && <FailureBlock failure={run.failure} ids={ids} />}
      {run.dialog ? <ChooseFolder run={run} failureIds={failureIds} /> : <PathForm run={run} failureIds={failureIds} />}
    </>
  );
}

/** What step 6 shows of the write that lives in the screen. */
type WorkflowStepRun = {
  /** The name of the project that gets the workflow, or its tag. */
  project: string | undefined;
  /** The words of a failed read of the projects, while the row has no project to name. */
  listFailure: string | undefined;
  running: boolean;
  failure: SetupFailure | undefined;
  onAdd: () => void;
};

function WorkflowContent({ run }: { run: WorkflowStepRun }): ReactNode {
  const ids = useFailureIds();
  const whyId = useId();
  const listId = useId();
  const failureIds = failureWordIds(run.failure, ids);
  const reading = !run.running && run.project === undefined;
  let words = run.failure === undefined ? "Add workflow" : "Try again";
  let description = run.failure === undefined ? [whyId] : failureIds;

  if (run.running) {
    words = "Adding workflow";
    description = [whyId];
  } else if (reading) {
    words = "Reading projects";
    description = run.listFailure === undefined ? failureIds : [listId, ...failureIds];
  }

  return (
    <>
      <p id={whyId} className={`${WHY_CLASS} wrap-anywhere`}>
        Tasma adds a default development workflow to
        {" "}
        {run.project === undefined ? "your project" : <span className="font-medium text-text">{run.project}</span>}
        . You can change it later.
      </p>
      {run.listFailure !== undefined && <p id={listId} className={RUN_CLASS}>{run.listFailure}</p>}
      {run.failure !== undefined && <FailureBlock failure={run.failure} ids={ids} />}
      <div className={ACTIONS_CLASS}>
        <Button
          type="button"
          aria-disabled={run.running || reading}
          aria-describedby={idRefs(description)}
          onClick={run.onAdd}
          className={BUTTON_FILLED_CLASS}
        >
          {(run.running || reading) && <Spinner />}
          {words}
        </Button>
      </div>
    </>
  );
}

type StepContentProps = Omit<SetupStepRowProps, "current" | "onPressInside">;

function StepContent(props: StepContentProps): ReactNode {
  const { step, checking, onCheckAgain, onStop, install, project, workflow } = props;

  if (step.state === "stopped") {
    return (
      <p className={WHY_CLASS}>
        Tasma does not check for the skill now. Claude Code needs the skill to run workflow steps.
      </p>
    );
  }
  if (step.state === "cannot-check" || step.state === "not-run") {
    return <CheckAgain checking={checking} onCheckAgain={onCheckAgain} />;
  }
  if (step.waitsFor !== undefined) {
    return <p className={WHY_CLASS}>{`First, complete step ${String(step.waitsFor.number)}: ${step.waitsFor.name}.`}</p>;
  }

  switch (step.id) {
    case "install":
      return (
        <>
          <p className={WHY_CLASS}>Tasma runs your workflows with Claude Code.</p>
          <div className={ACTIONS_CLASS}>
            <ExternalLink href={INSTALL_GUIDE_URL} className={BUTTON_FILLED_CLASS}>
              Open the Claude Code CLI install guide
            </ExternalLink>
          </div>
        </>
      );
    case "login":
      return (
        <>
          <p className={WHY_CLASS}>Chats run with your Claude Code account.</p>
          <RunCommand command="claude auth login" />
        </>
      );
    case "command":
      return (
        <>
          <p className={WHY_CLASS}>
            Claude Code uses this command to read and write tasks. Tasma adds it when the app opens, and macOS asks for
            your password one time.
          </p>
          <p className={RUN_CLASS}>
            If you did not allow this, in the menu bar, select
            {" "}
            <span className="font-medium text-text">Tasma &gt; Install Command Line Tool…</span>
          </p>
        </>
      );
    case "skill":
      return <SkillContent install={install} onStop={onStop} />;
    case "project":
      return <ProjectContent run={project} />;
    case "workflow":
      return <WorkflowContent run={workflow} />;
  }
}

type SetupStepRowProps = {
  step: SetupStep;
  current: boolean;
  /** The read of its "Check again" runs. */
  checking: boolean;
  onCheckAgain: () => void;
  onStop: () => void;
  install: SkillInstallRun;
  project: ProjectStepRun;
  workflow: WorkflowStepRun;
  /** The user pressed a control inside the panel. */
  onPressInside: () => void;
};

export function SetupStepRow({
  step,
  current,
  checking,
  onCheckAgain,
  onStop,
  install,
  project,
  workflow,
  onPressInside,
}: SetupStepRowProps): ReactNode {
  const [shown, setShown] = useState({ state: step.state, settling: false });

  if (shown.state !== step.state) {
    setShown({ state: step.state, settling: isChangeToDone(shown.state, step.state) });
  }

  if (!step.canOpen) {
    return (
      <li data-setup-step={step.id} className={ROW_CLASS}>
        <div className={HEAD_CLASS}>
          <StepHead step={step} current={current} settling={shown.settling} />
        </div>
      </li>
    );
  }

  function pressInside(event: MouseEvent): void {
    if ((event.target as Element).closest("button, a") !== null) {
      onPressInside();
    }
  }

  return (
    <Accordion.Item value={step.id} data-setup-step={step.id} render={<li />} className={ROW_CLASS}>
      <Accordion.Header render={<div />}>
        <Accordion.Trigger
          data-setup-trigger=""
          aria-label={`${step.name}, ${step.label}`}
          aria-current={current ? "step" : undefined}
          className={`group ${HEAD_CLASS}`}
        >
          <StepHead step={step} current={current} settling={false} />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel onClickCapture={pressInside} className="animate-enter pb-6 pl-10">
        <StepContent
          step={step}
          checking={checking}
          onCheckAgain={onCheckAgain}
          onStop={onStop}
          install={install}
          project={project}
          workflow={workflow}
        />
      </Accordion.Panel>
    </Accordion.Item>
  );
}
