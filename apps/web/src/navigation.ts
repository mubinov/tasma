import { FlowArrowIcon, FoldersIcon, GearIcon, HouseIcon, ListChecksIcon, type IconComponent } from "./lib/icons";

export type NavigationEntry = {
  path: string;
  label: string;
  icon: IconComponent;
};

// `as const` keeps each path a literal type, so a typo in a route or a link
// fails to typecheck.
export const PRIMARY_NAVIGATION = [
  {
    path: "/",
    label: "Dashboard",
    icon: HouseIcon,
  },
  {
    path: "/tasks",
    label: "Tasks",
    icon: ListChecksIcon,
  },
  {
    path: "/projects",
    label: "Projects",
    icon: FoldersIcon,
  },
  {
    path: "/workflows",
    label: "Workflows",
    icon: FlowArrowIcon,
  },
] as const satisfies readonly NavigationEntry[];

export const FOOTER_NAVIGATION = [
  {
    path: "/settings",
    label: "Settings",
    icon: GearIcon,
  },
] as const satisfies readonly NavigationEntry[];

type NavigationList = typeof PRIMARY_NAVIGATION | typeof FOOTER_NAVIGATION;

export type NavigationPath = NavigationList[number]["path"];

export const NAVIGATION_BY_PATH = Object.fromEntries(
  [...PRIMARY_NAVIGATION, ...FOOTER_NAVIGATION].map((entry) => [entry.path, entry]),
) as Record<NavigationPath, NavigationEntry>;
