import { Menu } from "@base-ui/react/menu";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import type { ProjectSummary } from "@tasma/protocol";
import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { CaretDownIcon } from "../lib/icons";
import { FILTER_FAILURE_TEXT, type FailedFields } from "../lib/use-chat-filter";
import { useFocusLost } from "../lib/use-focus-lost";
import { FIELD_TRIGGER_CLASS, MENU_RADIO_ITEM_CLASS, POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";
import { ProjectMenuItems, ProjectName } from "./project-select";
import { RadioIndicator } from "./radio-indicator";
import { RetryButton } from "./retry-button";
import { SearchBox } from "./search-field";

const route = getRouteApi("/");

type ChatFilterBarProps = {
  /** The project of the filter that the address requests. */
  project: string | undefined;
  projects: readonly ProjectSummary[];
  /** `null` while no read of the requested filter failed. */
  failedFields: FailedFields | null;
  onRetry: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Called when the project filter goes away while it, or its open menu, has the focus. */
  onFocusLost: () => void;
  /** Called when "Try again" goes away while it has the focus. */
  onRetryFocusLost: () => void;
};

/** The top of the list column: the search, the project filter, and the line of a failed read. */
export function ChatFilterBar(
  { project, projects, failedFields, onRetry, inputRef, onFocusLost, onRetryFocusLost }: ChatFilterBarProps,
): ReactNode {
  const failureId = useId();

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-line p-3">
        <ChatSearchField inputRef={inputRef} describedBy={failedFields?.search === true ? failureId : undefined} />
        <ChatProjectFilter
          project={project}
          projects={projects}
          describedBy={failedFields?.project === true ? failureId : undefined}
          onFocusLost={onFocusLost}
        />
      </div>
      {failedFields !== null && (
        <div className="flex items-center gap-3 border-b border-line p-3">
          <p id={failureId} className="min-w-0 text-sm text-subtle">{FILTER_FAILURE_TEXT}</p>
          <RetryButton onRetry={onRetry} onFocusLost={onRetryFocusLost} />
        </div>
      )}
    </>
  );
}

type ChatSearchFieldProps = { inputRef: RefObject<HTMLInputElement | null>; describedBy: string | undefined };

function ChatSearchField({ inputRef, describedBy }: ChatSearchFieldProps): ReactNode {
  const { q } = route.useSearch();
  const navigate = route.useNavigate();
  const router = useRouter();

  return (
    <SearchBox
      label="Search chats"
      q={q}
      // A change of the project keeps the text.
      resetKey=""
      onWrite={(text) => {
        void navigate({
          to: "/",
          search: (previous) => ({ ...previous, q: text === "" ? undefined : text }),
          replace: true,
          resetScroll: false,
        });
      }}
      canWriteDelayed={() => router.latestLocation.pathname === "/"}
      busy={false}
      describedBy={describedBy}
      placeholder="Search"
      clearLabel="Clear the search"
      className="w-full"
      inputRef={inputRef}
    />
  );
}

type ChatProjectFilterProps = {
  project: string | undefined;
  projects: readonly ProjectSummary[];
  describedBy: string | undefined;
  onFocusLost: () => void;
};

function ChatProjectFilter({ project, projects, describedBy, onFocusLost }: ChatProjectFilterProps): ReactNode {
  const navigate = route.useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const name = projects.find(({ tag }) => tag === project)?.name;

  useFocusLost(triggerRef, onFocusLost, open);

  return (
    <Menu.Root highlightItemOnHover={false} open={open} onOpenChange={setOpen}>
      <Menu.Trigger ref={triggerRef} aria-describedby={describedBy} className={FIELD_TRIGGER_CLASS}>
        <span className="min-w-0">
          {/* The space is outside the hidden text, where the accessible name keeps it. */}
          <span className="sr-only">Project:</span>
          {" "}
          {project === undefined ? "All projects" : <ProjectName name={name} tag={project} />}
        </span>
        <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className={POSITIONER_CLASS}>
          <Menu.Popup className={`w-(--anchor-width) ${POPUP_CLASS}`}>
            <Menu.RadioGroup
              value={project ?? ""}
              onValueChange={(next: string) => {
                void navigate({
                  to: "/",
                  search: (previous) => ({ ...previous, project: next === "" ? undefined : next }),
                  replace: true,
                  resetScroll: false,
                });
              }}
            >
              <Menu.RadioItem value="" closeOnClick className={MENU_RADIO_ITEM_CLASS}>
                <RadioIndicator />
                All projects
              </Menu.RadioItem>
              <Menu.Separator className="my-1 h-px bg-line" />
              <ProjectMenuItems projects={projects} />
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
