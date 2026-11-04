import { Accordion } from "@base-ui/react/accordion";
import { Button } from "@base-ui/react/button";
import type { SkillInstall } from "@tasma/protocol";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { CaretDownIcon, CheckIcon, CircleNotchIcon } from "../lib/icons";
import { isChangeToDone, type SetupStep, type SkillInstallState, type StepState } from "../lib/setup-steps";
import { useNoticeStore } from "../store/notices";
import { BUTTON_CLASS, BUTTON_FILLED_CLASS } from "./control-classes";

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

type CopyButtonProps = {
  text: string;
  /** The element that holds the text, which a failed copy selects. */
  holder: RefObject<HTMLElement | null>;
  /** What the words of a failed copy call the text. */
  noun: "command" | "output";
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

function CommandBox({ command }: { command: string }): ReactNode {
  const codeRef = useRef<HTMLElement>(null);
  const codeId = useId();

  return (
    <div className="mt-1.5 flex w-full max-w-lg items-center justify-between gap-3 rounded-control bg-surface-2 py-1.5 pr-1.5 pl-3">
      <code ref={codeRef} id={codeId} className="font-mono text-xs-plus wrap-anywhere">{command}</code>
      <CopyButton text={command} holder={codeRef} noun="command" describedBy={codeId} />
    </div>
  );
}

function RunCommand({ command, words = "Run this command in a terminal:" }: { command: string; words?: string }): ReactNode {
  return (
    <>
      <p className={RUN_CLASS}>{words}</p>
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
      <RunCommand
        command="/plugin marketplace add mubinov/tasma-skill"
        words="To install the skill as a Claude Code plugin, run these commands in Claude Code:"
      />
      <CommandBox command="/plugin install tasma@tasma" />
      <p className={RUN_CLASS}>Or install Node.js, and then select &quot;Try again&quot;.</p>
    </>
  );
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
          {running && <CircleNotchIcon size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
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

type StepContentProps = Pick<SetupStepRowProps, "step" | "checking" | "onCheckAgain" | "onStop" | "install">;

function StepContent({ step, checking, onCheckAgain, onStop, install }: StepContentProps): ReactNode {
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
              Open the Claude Code install guide
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
      return (
        <>
          <p className={WHY_CLASS}>Choose the folder with your code. Claude Code works in this folder.</p>
          <RunCommand command="tasma project create --path ." words="Open a terminal in this folder, and run this command:" />
        </>
      );
    case "workflow":
      return (
        <p className={WHY_CLASS}>
          A workflow gives each task its steps. Ask Claude Code to create a workflow for your project.
        </p>
      );
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
        <StepContent step={step} checking={checking} onCheckAgain={onCheckAgain} onStop={onStop} install={install} />
      </Accordion.Panel>
    </Accordion.Item>
  );
}
