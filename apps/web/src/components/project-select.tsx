import { Combobox } from "@base-ui/react/combobox";
import { Menu } from "@base-ui/react/menu";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { ProjectSummary } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { ALL_PROJECTS, boardValue, pickBoard, readBoard, type BoardAddress } from "../lib/board";
import { CaretDownIcon } from "../lib/icons";
import { useNoticeStore } from "../store/notices";
import { GROUP_CLASS, LABEL_CLASS, MENU_RADIO_ITEM_CLASS, TRIGGER_CLASS } from "./control-classes";
import { FilterPopup, PICKER_ITEM_CLASS, PickerCheck } from "./property-picker";
import { RadioIndicator } from "./radio-indicator";
import { Tag } from "./tag";

type BoardSearch = { projects?: string; labels?: string; q?: string };

type ProjectSelectProps = {
  projects: readonly ProjectSummary[];
  /** The board value of the board's own address. */
  board: string;
  /** The filters of the board's own address. */
  labels: string | undefined;
  q: string | undefined;
};

/** One inline run, so a long name wraps inside its box, also inside a word, and the tag moves to a new line whole. */
export function ProjectName({ name, tag, id }: { name: string | undefined; tag: string; id?: string }): ReactNode {
  return (
    <span id={id} className="min-w-0 wrap-anywhere">
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

/** The radio item of each project, in the order of `projects`, for a `Menu.RadioGroup`. */
export function ProjectMenuItems({ projects }: { projects: readonly ProjectSummary[] }): ReactNode {
  return projects.map((project) => (
    // A radio item stays open on a click by default, and the screen stays
    // mounted when the project changes.
    <Menu.RadioItem key={project.tag} value={project.tag} closeOnClick className={MENU_RADIO_ITEM_CLASS}>
      <RadioIndicator />
      <ProjectName name={project.name} tag={project.tag} />
    </Menu.RadioItem>
  ));
}

const ALL_WORDS = "All projects";

function nameOf(projects: readonly ProjectSummary[], tag: string): string | undefined {
  return projects.find((project) => project.tag === tag)?.name;
}

/** The text of the trigger for a board. */
function boardWords({ all, tags }: BoardAddress, projects: readonly ProjectSummary[]): string {
  if (all) {
    return ALL_WORDS;
  }
  if (tags.length === 1) {
    const name = nameOf(projects, tags[0]!);

    return name === undefined ? tags[0]! : `${name} ${tags[0]!}`;
  }
  return tags.map((tag) => nameOf(projects, tag) ?? tag).join(", ");
}

/**
 * The items and the value are `all` and tags alike: Base UI compares an item
 * with a value exactly, so the keyword `all` and a tag `ALL` stay two items.
 */
export function ProjectSelect({ projects, board, labels, q }: ProjectSelectProps): ReactNode {
  const navigate = useNavigate();
  const router = useRouter();
  const labelId = useId();
  const valueId = useId();
  // The address changes before the next board renders, while its loader runs,
  // so the picker follows each click at once. Away from the board, while the
  // next screen loads, it keeps the board it was given.
  const located = useRouterState({
    select: ({ location }) => (location.pathname === "/tasks" ? location.search.projects : undefined),
  });
  const shown = readBoard(located ?? board);
  const value = shown.all ? [ALL_PROJECTS] : shown.tags;
  const listed = projects.map((project) => project.tag);
  const items = [ALL_PROJECTS, ...listed, ...shown.tags.filter((tag) => !listed.includes(tag))];

  function matches(item: string, query: string): boolean {
    const text = query.toLowerCase();
    const words = item === ALL_PROJECTS ? [ALL_WORDS] : [item, nameOf(projects, item) ?? ""];

    return words.some((word) => word.toLowerCase().includes(text));
  }

  /** Base UI gives the value with the clicked item added or taken out. */
  function pick(next: string[]): void {
    const clicked = (next.find((item) => !value.includes(item)) ?? value.find((item) => !next.includes(item)))!;

    if (boardValue(pickBoard(shown, clicked)) === boardValue(shown)) {
      return;
    }

    // A second click during the load builds on the address of the first one.
    // While another screen loads, the address holds no board, and a click
    // builds on the board that the picker shows.
    const search = (previous: BoardSearch): BoardSearch => {
      const base = previous.projects === undefined ? { projects: board, labels, q } : previous;

      return { ...base, projects: boardValue(pickBoard(readBoard(base.projects), clicked)) };
    };
    const built: BoardSearch = router.buildLocation({ to: "/tasks", search }).search;

    void navigate({ to: "/tasks", search });
    useNoticeStore.getState().announce(`${boardWords(readBoard(built.projects), projects)}.`);
  }

  return (
    <div className={GROUP_CLASS}>
      <span id={labelId} className={LABEL_CLASS}>
        Project
      </span>
      {/* Hover does not highlight an item, so the ring is never a hover mark. */}
      <Combobox.Root
        multiple
        highlightItemOnHover={false}
        items={items}
        value={value}
        filter={matches}
        onValueChange={pick}
      >
        {/* Named by the value, not by itself: the trigger is a combobox, and the
            name of a combobox in a label reference is its value, which is empty. */}
        <Combobox.Trigger aria-labelledby={`${labelId} ${valueId}`} className={TRIGGER_CLASS}>
          {!shown.all && shown.tags.length === 1
            ? <ProjectName id={valueId} name={nameOf(projects, shown.tags[0]!)} tag={shown.tags[0]!} />
            : <span id={valueId} className="max-w-64 truncate">{boardWords(shown, projects)}</span>}
          <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
        </Combobox.Trigger>
        <FilterPopup labelId={labelId} placeholder="Filter projects" empty="No project matches">
          {(item) => (
            <Combobox.Item key={item} value={item} className={PICKER_ITEM_CLASS}>
              <PickerCheck />
              {item === ALL_PROJECTS
                ? <span className="min-w-0 wrap-anywhere">{ALL_WORDS}</span>
                : <ProjectName name={nameOf(projects, item)} tag={item} />}
            </Combobox.Item>
          )}
        </FilterPopup>
      </Combobox.Root>
    </div>
  );
}
