import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import type { ProjectSummary } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { CaretDownIcon } from "../lib/icons";
import {
  GROUP_CLASS,
  LABEL_CLASS,
  MENU_RADIO_ITEM_CLASS,
  POPUP_CLASS,
  POSITIONER_CLASS,
  TRIGGER_CLASS,
} from "./control-classes";
import { RadioIndicator } from "./radio-indicator";
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
                  // stays mounted when the project changes.
                  <Menu.RadioItem key={project.tag} value={project.tag} closeOnClick className={MENU_RADIO_ITEM_CLASS}>
                    <RadioIndicator />
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
