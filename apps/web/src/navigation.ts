import { FlowArrowIcon, FoldersIcon, GearIcon, HouseIcon, ListChecksIcon, type IconComponent } from "./lib/icons";

export type NavigationEntry = {
  path: string;
  label: string;
  icon: IconComponent;
  summary: string;
};

// `as const` keeps each path a literal type, so a typo in a route or a link
// fails to typecheck.
export const PRIMARY_NAVIGATION = [
  {
    path: "/",
    label: "Dashboard",
    icon: HouseIcon,
    summary: "What needs a human and what the agents are working on will be summarised here.",
  },
  {
    path: "/tasks",
    label: "Tasks",
    icon: ListChecksIcon,
    summary: "Every task in the workspace will be listed here, whoever is working on it.",
  },
  {
    path: "/projects",
    label: "Projects",
    icon: FoldersIcon,
    summary: "The repositories tasma tracks will be listed here.",
  },
  {
    path: "/workflows",
    label: "Workflows",
    icon: FlowArrowIcon,
    summary: "The workflows a task can run, and the steps each one takes, will be shown here.",
  },
] as const satisfies readonly NavigationEntry[];

export const FOOTER_NAVIGATION = [
  {
    path: "/settings",
    label: "Settings",
    icon: GearIcon,
    summary: "The daemon address, the project root and the agent adapters will be configured here.",
  },
] as const satisfies readonly NavigationEntry[];

type NavigationList = typeof PRIMARY_NAVIGATION | typeof FOOTER_NAVIGATION;

export type NavigationPath = NavigationList[number]["path"];

export const NAVIGATION_BY_PATH = Object.fromEntries(
  [...PRIMARY_NAVIGATION, ...FOOTER_NAVIGATION].map((entry) => [entry.path, entry]),
) as Record<NavigationPath, NavigationEntry>;
