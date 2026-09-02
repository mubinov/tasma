import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SidebarSimpleIcon } from "../lib/icons";
import { FOOTER_NAVIGATION, PRIMARY_NAVIGATION, type NavigationEntry } from "../navigation";
import { useUiStore } from "../store/ui";

const ROW_CLASS = "flex h-10 w-full items-center overflow-hidden rounded-control";
const ICON_BOX_CLASS = "flex size-10 shrink-0 items-center justify-center";
const LIST_CLASS = "flex flex-col gap-1 px-3 py-1";
// A duration and an easing with no property of their own: they time whichever
// transition-* utility they are written beside.
const TIMING_CLASS = "duration-(--duration-base) ease-standard";
const IDLE_TEXT_CLASS = "text-dim hover:text-text";

const SIDEBAR_ID = "sidebar";

// Faded and clipped rather than removed: `display: none` would strip the
// accessible name from the link the label belongs to.
function CollapsingLabel({
  collapsed,
  className,
  children,
}: {
  collapsed: boolean;
  className: string;
  children: string;
}): ReactNode {
  const fade = collapsed ? "opacity-0" : "opacity-0 sm:opacity-100";

  return (
    <span className={`shrink-0 whitespace-nowrap transition-opacity ${TIMING_CLASS} ${fade} ${className}`}>
      {children}
    </span>
  );
}

function SidebarLink({ entry, collapsed }: { entry: NavigationEntry; collapsed: boolean }): ReactNode {
  const Icon = entry.icon;

  return (
    <li>
      <Link
        to={entry.path}
        // Every path starts with "/", so prefix matching would leave Dashboard
        // marked current on every screen.
        activeOptions={{ exact: entry.path === "/" }}
        className={ROW_CLASS}
        // Set from one side or the other, never overridden: two utilities of the
        // same property are settled by the generated stylesheet's order.
        activeProps={{ className: "bg-surface text-text" }}
        inactiveProps={{ className: IDLE_TEXT_CLASS }}
      >
        {({ isActive }) => (
          <>
            <span className={ICON_BOX_CLASS}>
              {/* The fill is the active mark that survives forced-colors mode,
                  where both colours are dropped. */}
              <Icon size={20} weight={isActive ? "fill" : "regular"} aria-hidden="true" />
            </span>
            <CollapsingLabel collapsed={collapsed} className="text-sm">
              {entry.label}
            </CollapsingLabel>
          </>
        )}
      </Link>
    </li>
  );
}

export function Sidebar(): ReactNode {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const setCollapsed = useUiStore((state) => state.setSidebarCollapsed);

  return (
    <header
      id={SIDEBAR_ID}
      className={`flex shrink-0 flex-col border-r border-line bg-surface-2 transition-[width] ${TIMING_CLASS} ${
        collapsed ? "w-16" : "w-16 sm:w-60"
      }`}
    >
      <div className="px-3 py-4">
        <div className={ROW_CLASS}>
          <span className={ICON_BOX_CLASS}>
            <span className="size-6 rounded-control bg-graphic" />
          </span>
          <CollapsingLabel collapsed={collapsed} className="font-chrome text-lg font-semibold tracking-tight">
            tasma
          </CollapsingLabel>
        </div>
      </div>

      {/* The side padding sits on the lists, so the foot's border spans the
          sidebar's full width. */}
      <nav className="flex flex-1 flex-col">
        <ul className={LIST_CLASS}>
          {PRIMARY_NAVIGATION.map((entry) => (
            <SidebarLink key={entry.path} entry={entry} collapsed={collapsed} />
          ))}
        </ul>
        <ul className={`${LIST_CLASS} mt-auto border-t border-line`}>
          {FOOTER_NAVIGATION.map((entry) => (
            <SidebarLink key={entry.path} entry={entry} collapsed={collapsed} />
          ))}
        </ul>
      </nav>

      <div className="hidden px-3 py-2 sm:block">
        {/* A disclosure, so a plain button with aria-expanded. Base UI's Toggle
            is an aria-pressed control and would say the wrong thing. */}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={SIDEBAR_ID}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed(!collapsed)}
          className={`${ROW_CLASS} ${IDLE_TEXT_CLASS}`}
        >
          <span className={ICON_BOX_CLASS}>
            <SidebarSimpleIcon size={20} aria-hidden="true" />
          </span>
        </button>
      </div>
    </header>
  );
}
