import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import type { ProjectSummary } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon } from "../lib/icons";
import { GROUP_CLASS, LABEL_CLASS, POPUP_CLASS, POSITIONER_CLASS, TRIGGER_CLASS } from "./control-classes";
import { Tag } from "./tag";

type ProjectSelectProps = {
  projects: readonly ProjectSummary[];
  tag: string;
};

/** One inline run, so a long name wraps inside its box, also inside a word, and the tag moves to a new line whole. */
function ProjectName({ name, tag }: { name: string | undefined; tag: string }): ReactNode {
  return (
    <span className="min-w-0 wrap-anywhere">
      {name ?? tag}
      {/* The space separates the name and the tag in the accessible name. */}
      {name !== undefined && (
        <>
          {" "}
          <Tag>{tag}</Tag>
        </>
      )}
    </span>
  );
}

export function ProjectSelect({ projects, tag }: ProjectSelectProps): ReactNode {
  const navigate = useNavigate();
  const labelId = useId();
  const triggerId = useId();
  const name = projects.find((project) => project.tag === tag)?.name;

  return (
    <div className={GROUP_CLASS}>
      <span id={labelId} className={LABEL_CLASS}>
        Project
      </span>
      {/* Hover does not highlight an item, so the ring is never a hover mark. */}
      <Menu.Root highlightItemOnHover={false}>
        <Menu.Trigger id={triggerId} aria-labelledby={`${labelId} ${triggerId}`} className={TRIGGER_CLASS}>
          <ProjectName name={name} tag={tag} />
          <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
            <Menu.Popup className={`max-w-(--available-width) min-w-52 ${POPUP_CLASS}`}>
              <Menu.RadioGroup
                value={tag}
                onValueChange={(next: string) => {
                  void navigate({ to: "/tasks", search: { projects: next } });
                }}
              >
                {projects.map((project) => (
                  // A radio item stays open on a click by default, and the board
                  // stays mounted when the project changes. A mouse press focuses
                  // and highlights the item, so the ring is hidden while the button is held.
                  <Menu.RadioItem
                    key={project.tag}
                    value={project.tag}
                    closeOnClick
                    className="flex min-h-8 items-center gap-2 rounded-control px-2 py-1 text-sm text-text hover:bg-surface-2 data-[highlighted]:bg-surface-2 data-[highlighted]:outline-3 data-[highlighted]:outline-offset-2 data-[highlighted]:outline-graphic data-[highlighted]:active:outline-hidden data-[checked]:text-dim"
                  >
                    <Menu.RadioItemIndicator keepMounted className="flex w-3.5 shrink-0 data-[unchecked]:invisible">
                      <CheckIcon size={14} aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                    <ProjectName name={project.name} tag={project.tag} />
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
