import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Menu } from "@base-ui/react/menu";
import { Thread, type ThreadComponents } from "@kit/components/assistant-ui/elements/thread.aui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ChatAgent, ProjectSummary } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { projectChatStartOptions, usePendingProjectChatStart } from "../api/mutations";
import { agentOptionsQuery } from "../api/queries";
import { chatAgentName, messageText } from "../lib/chat-messages";
import { CHAT_HEADING_MARK, focusInView, KIT_INPUT, NEW_CHAT_MARK } from "../lib/focus-in-view";
import { CaretDownIcon } from "../lib/icons";
import { useChatThreadFocus } from "../lib/use-chat-thread-focus";
import { useFocusLost } from "../lib/use-focus-lost";
import { useNewChatOptionPicks, type DroppedPicks, type NewChatOption } from "../lib/use-new-chat-option-picks";
import { usePendingFocus } from "../lib/use-pending-focus";
import { projectChatStartFailure } from "../lib/write-failure";
import { NEW_CHAT_DRAFT } from "../store/chat-drafts";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { ChatOptionMenu, ChatPickerRow } from "./chat-option-menu";
import { ChatDraft } from "./chat-panel";
import { ChatsLink } from "./chats-link";
import {
  CHAT_COLUMN_CLASS,
  GROUP_CLASS,
  LABEL_CLASS,
  MENU_ITEM_CLASS,
  MENU_RADIO_ITEM_CLASS,
  POPUP_CLASS,
  POSITIONER_CLASS,
  TRIGGER_CLASS,
} from "./control-classes";
import { ProjectName } from "./project-select";
import { RadioIndicator } from "./radio-indicator";

const NO_PROJECTS = "No projects yet. Add one on the Projects screen.";

const NEW_CHAT_AGENT: ChatAgent = "claude";

type NewChatProps = {
  /** The project of the Dashboard filter. */
  filterProject: string | undefined;
  projects: readonly ProjectSummary[];
  wide: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Called when "Chats" closes the view. */
  onBack: () => void;
  /** Called at Send, with the tag of the project. */
  onStart: (tag: string) => void;
};

/** What the view gives the composer slot through `extras` of the runtime. */
type NewChatExtras = {
  projects: readonly ProjectSummary[];
  /** The project of the view, or the project of the start that waits. */
  selected: string | null;
  waiting: boolean;
  openWords: string;
  onPick: (tag: string) => void;
  onFocusLost: () => void;
  options: readonly NewChatOption[];
  onOptionPick: (option: NewChatOption, value: string) => void;
  /** Moves the focus to the heading at once. */
  onOptionFocusLost: () => void;
  /**
   * The picks that the last change of the list dropped. The slot says them
   * after it renders the row, so after the focus leaves a menu that the change
   * removed.
   */
  dropped: DroppedPicks | null;
};

type ProjectPickerProps = Pick<NewChatExtras, "projects" | "selected" | "waiting" | "onPick" | "onFocusLost">;

const NO_MESSAGES: readonly ThreadMessageLike[] = [];

function hasFolder(projects: readonly ProjectSummary[], tag: string | null): boolean {
  return projects.some((project) => project.tag === tag && project.path !== undefined);
}

function preselect(
  projects: readonly ProjectSummary[],
  filterProject: string | undefined,
  last: string | null,
): string | null {
  if (filterProject !== undefined) {
    return hasFolder(projects, filterProject) ? filterProject : null;
  }
  return hasFolder(projects, last) ? last : null;
}

function openWords(selected: string | null, projects: readonly ProjectSummary[]): string {
  if (selected !== null) {
    return `New chat in ${selected}`;
  }
  return projects.length === 0 ? "New chat. No projects yet." : "New chat. Select a project.";
}

function ProjectPicker({ projects, selected, waiting, onPick, onFocusLost }: ProjectPickerProps): ReactNode {
  const labelId = useId();
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const project = projects.find(({ tag }) => tag === selected);

  useFocusLost(triggerRef, onFocusLost, open);

  return (
    <div className={GROUP_CLASS}>
      <span id={labelId} className={LABEL_CLASS}>Project</span>
      <Menu.Root
        highlightItemOnHover={false}
        open={open}
        onOpenChange={(next) => {
          setOpen(next && !waiting);
        }}
      >
        <Menu.Trigger
          ref={triggerRef}
          id={triggerId}
          aria-labelledby={`${labelId} ${triggerId}`}
          aria-disabled={waiting || undefined}
          className={`${TRIGGER_CLASS} aria-disabled:hover:border-line`}
        >
          {project === undefined
            ? <span className="text-signal">Select a project</span>
            : <ProjectName name={project.name} tag={project.tag} />}
          <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="start" sideOffset={4} className={POSITIONER_CLASS}>
            <Menu.Popup aria-labelledby={labelId} className={`max-h-(--available-height) max-w-(--available-width) min-w-60 overflow-y-auto ${POPUP_CLASS}`}>
              {projects.length === 0
                ? <Menu.Item disabled className={MENU_ITEM_CLASS}>{NO_PROJECTS}</Menu.Item>
                : (
                    <Menu.RadioGroup value={selected} onValueChange={onPick}>
                      {projects.map(({ tag, name, path }) => (
                        <Menu.RadioItem key={tag} value={tag} disabled={path === undefined} closeOnClick className={`${MENU_RADIO_ITEM_CLASS} data-[disabled]:text-dim`}>
                          <RadioIndicator />
                          {path === undefined
                            ? (
                                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                  <span className="min-w-0 wrap-anywhere">{name ?? tag}</span>
                                  <span className="shrink-0 text-xs-plus">No folder</span>
                                </span>
                              )
                            : <ProjectName name={name} tag={tag} />}
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

/** A sibling after the message field, so its effect runs after the effect with which the field takes the focus. */
function OpenWords({ words }: { words: string }): null {
  const say = useEffectEvent(() => {
    useNoticeStore.getState().announce(words);
  });

  useEffect(() => {
    say();
  }, []);

  return null;
}

function NewChatComposerStart(): ReactNode {
  const {
    projects,
    selected,
    waiting,
    openWords: words,
    onPick,
    onFocusLost,
    options,
    onOptionPick,
    onOptionFocusLost,
    dropped,
  } = useAuiState((s) => s.thread.extras) as NewChatExtras;

  useEffect(() => {
    for (const one of dropped?.words ?? []) {
      useNoticeStore.getState().announce(one);
    }
  }, [dropped]);

  return (
    <ChatPickerRow>
      <ProjectPicker
        projects={projects}
        selected={selected}
        waiting={waiting}
        onPick={onPick}
        onFocusLost={onFocusLost}
      />
      <OpenWords words={words} />
      {options.map((option) => (
        <ChatOptionMenu
          key={option.listed.category}
          option={option.shown}
          hidden={option.hidden}
          waiting={waiting}
          onPick={(value) => {
            onOptionPick(option, value);
          }}
          onFocusLost={onOptionFocusLost}
        />
      ))}
    </ChatPickerRow>
  );
}

function NoWelcome(): null {
  return null;
}

const NEW_CHAT_COMPONENTS: ThreadComponents = {
  Welcome: NoWelcome,
  ComposerStart: NewChatComposerStart,
};

type NewChatThreadProps = {
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** What Enter says with text in the field and no project, or `null` with a project. */
  noProjectWords: string | null;
};

function NewChatThread({ headingRef, noProjectWords }: NewChatThreadProps): ReactNode {
  const aui = useAui();
  const ref = useRef<HTMLDivElement>(null);
  const focusHeading = (): void => {
    focusInView(headingRef.current);
  };
  const focusEvents = useChatThreadFocus(ref, focusHeading);

  useFocusLost(ref, focusHeading);

  return (
    <div
      ref={ref}
      {...focusEvents}
      onKeyDownCapture={({ key, shiftKey, nativeEvent, target }) => {
        if (
          key === "Enter"
          && !shiftKey
          && !nativeEvent.isComposing
          && noProjectWords !== null
          && !aui.composer.getState().isEmpty
          && (target as Element).matches(KIT_INPUT)
        ) {
          useNoticeStore.getState().announce(noProjectWords);
        }
      }}
      className="min-h-0 flex-1"
    >
      <Thread components={NEW_CHAT_COMPONENTS} />
    </div>
  );
}

/**
 * The start of a chat of a project, in the place of an open chat. The first
 * message shows as a later message does while the start waits, and the composer
 * is the composer of the kit, with the picker row in its action row.
 */
export function NewChat({ filterProject, projects, wide, headingRef, onBack, onStart }: NewChatProps): ReactNode {
  const router = useRouter();
  const { client, queryClient } = router.options.context;
  const { mutateAsync: start } = useMutation(projectChatStartOptions(queryClient, client, router), queryClient);
  const pending = usePendingProjectChatStart();
  const [picked, setPicked] = useState(() => preselect(projects, filterProject, useUiStore.getState().lastChatProject));
  // A project that leaves the list, or loses its folder, while the view is open is not selected.
  const selected = pending?.start.tag ?? (hasFolder(projects, picked) ? picked : null);
  const waiting = pending !== undefined;
  const { data: agentOptions } = useQuery(agentOptionsQuery(client, NEW_CHAT_AGENT), queryClient);
  const { options, dropped, changed, pick } = useNewChatOptionPicks({
    agent: NEW_CHAT_AGENT,
    configOptions: agentOptions?.data.options,
    sent: pending === undefined ? null : (pending.start.options ?? {}),
  });
  const headingId = useId();
  const pendingFocus = usePendingFocus();

  function focusHeading(): void {
    pendingFocus(() => {
      focusInView(headingRef.current);
    });
  }

  const extras: NewChatExtras = {
    projects,
    selected,
    waiting,
    openWords: openWords(selected, projects),
    onPick: setPicked,
    onFocusLost: focusHeading,
    options,
    onOptionPick: pick,
    // A menu leaves in a render of the kit store, which does not render the view, so a pending move would not run.
    onOptionFocusLost: () => {
      focusInView(headingRef.current);
    },
    dropped,
  };
  const runtime = useExternalStoreRuntime({
    messages: pending === undefined
      ? NO_MESSAGES
      : [{ id: "new-chat-first", role: "user", content: [{ type: "text", text: pending.start.text }] }],
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: waiting,
    isSendDisabled: selected === null || waiting,
    // The factory puts the text back, so the failure is not a `MessageNotSentError`, which the kit would put back too.
    onNew: async (message) => {
      const tag = selected!;

      onStart(tag);
      await start({
        start: { tag, text: messageText(message), ...(changed === undefined ? {} : { options: changed }) },
        failure: projectChatStartFailure(tag),
      });
    },
    extras,
  });
  const noProjectWords = selected !== null
    ? null
    : (projects.length === 0 ? NO_PROJECTS : "Select a project to send the message.");

  return (
    <section
      aria-labelledby={headingId}
      {...NEW_CHAT_MARK}
      className="flex h-full min-w-0 flex-1 flex-col bg-bg pb-(--notice-stack-height)"
    >
      <div className="border-b border-line">
        <div className={`${CHAT_COLUMN_CLASS} flex items-start gap-3 px-6 py-3`}>
          <div className="min-w-0 flex-1">
            {!wide && <ChatsLink onBack={onBack} onFocusLost={focusHeading} />}
            <h2 ref={headingRef} id={headingId} tabIndex={-1} {...CHAT_HEADING_MARK} className="font-chrome text-base font-semibold">
              New chat
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-subtle">{chatAgentName(NEW_CHAT_AGENT)}</span>
            </p>
          </div>
        </div>
      </div>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatDraft place={NEW_CHAT_DRAFT} />
        <NewChatThread headingRef={headingRef} noProjectWords={noProjectWords} />
      </AssistantRuntimeProvider>
    </section>
  );
}
