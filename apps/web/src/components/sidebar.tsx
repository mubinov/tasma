import { Link } from "@tanstack/react-router";
import type { AgentState } from "@tasma/protocol";
import type { ReactNode } from "react";
import { SidebarSimpleIcon } from "../lib/icons";
import { useAgentSignal, type AgentSignal } from "../lib/use-agent-signal";
import { FOOTER_NAVIGATION, PRIMARY_NAVIGATION, type NavigationEntry } from "../navigation";
import { useUiStore } from "../store/ui";
import { ChatsStateIcon } from "./chats-state-icon";
import { CollapsingLabel, ICON_BOX_CLASS, IDLE_TEXT_CLASS, ROW_CLASS, TIMING_CLASS } from "./sidebar-row";
import { UpdateItem } from "./update-item";

const LIST_CLASS = "flex flex-col gap-1 px-3 py-1";

const SIDEBAR_ID = "sidebar";

// Never narrower than the window buttons need. The width itself takes the maximum, so the fixed box inherits it.
// `--sidebar-width` is the end width: it does not follow the collapse transition.
const RAIL_WIDTH_CLASS = "w-[max(--spacing(16),var(--title-controls))] [html:has(&)]:scroll-pl-[max(--spacing(16),var(--title-controls))] [html:has(&)]:[--sidebar-width:max(--spacing(16),var(--title-controls))]";

const FULL_WIDTH_CLASS = "sm:w-[max(--spacing(60),var(--title-controls))] sm:[html:has(&)]:scroll-pl-[max(--spacing(60),var(--title-controls))] sm:[html:has(&)]:[--sidebar-width:max(--spacing(60),var(--title-controls))]";

// One rounded border draws the line below the band, the curve and the line beside the sidebar, because WebKit rounds a
// border, a shadow and a gradient to different widths at a page zoom. The page scrolls on `html`, which would carry a
// frame on `<main>` away. The shadow fills the area outside the curve, and the clip keeps it there.
const PAGE_FRAME_CLASS = "after:pointer-events-none after:absolute after:top-(--title-band) after:bottom-0 after:left-full after:w-screen after:rounded-tl-(--panel-corner) after:border-l after:border-line after:shadow-[0_0_0_var(--panel-corner)_var(--color-surface-2)] after:[border-top-width:min(1px,var(--title-band))] after:[clip-path:inset(0)] after:[--panel-corner:min(var(--radius-panel),var(--title-band))]";

const AGENT_STATE_WORDS: Record<AgentState, string> = {
  "off": "",
  "running": ", agent works",
  "needs-you": ", needs you",
};

type SidebarLinkProps = { entry: NavigationEntry; collapsed: boolean; signal: AgentSignal };

function SidebarLink({ entry, collapsed, signal }: SidebarLinkProps): ReactNode {
  const Icon = entry.icon;
  const stopMotion = Icon === "agent-state" ? signal.stopMotion : undefined;

  return (
    <li>
      <Link
        to={entry.path}
        // Every path starts with "/", so prefix matching would leave Chats
        // marked current on every screen. The search of an address does not
        // change the screen.
        activeOptions={{ exact: entry.path === "/", includeSearch: false }}
        className={ROW_CLASS}
        // Set from one side or the other, never overridden: two utilities of the
        // same property are settled by the generated stylesheet's order.
        activeProps={{ className: "bg-surface text-text" }}
        inactiveProps={{ className: IDLE_TEXT_CLASS }}
        onPointerEnter={stopMotion}
        onFocus={stopMotion}
      >
        {({ isActive }) => (
          <>
            <span className={ICON_BOX_CLASS}>
              {/* The fill is the active mark that survives forced-colors mode,
                  where both colours are dropped. On the agent state icon the
                  fill of the lamp means the state, so that icon has no such mark. */}
              {Icon === "agent-state"
                ? <ChatsStateIcon state={signal.state} still={signal.still} />
                : <Icon size={20} weight={isActive ? "fill" : "regular"} aria-hidden="true" />}
            </span>
            <CollapsingLabel collapsed={collapsed} className="text-sm">
              {entry.label}
            </CollapsingLabel>
            {Icon === "agent-state" && <span className="sr-only">{AGENT_STATE_WORDS[signal.state]}</span>}
          </>
        )}
      </Link>
    </li>
  );
}

export function Sidebar(): ReactNode {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const setCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const signal = useAgentSignal();

  return (
    // The header holds the width in the row; its content is fixed, since a
    // sticky box cannot leave the shell, which a wide board overflows. The
    // content inherits the width, so it follows the collapse transition. The
    // page's scroll padding matches the width, so a focus scroll keeps its
    // target clear of the fixed content.
    <header
      id={SIDEBAR_ID}
      className={`shrink-0 transition-[width] ${TIMING_CLASS} ${RAIL_WIDTH_CLASS} ${collapsed ? "" : FULL_WIDTH_CLASS}`}
    >
      {/* A top padding in a scroll box scrolls away, so the band is on a box that does not scroll. */}
      <div className={`fixed inset-y-0 left-0 z-(--layer-sidebar) flex w-[inherit] flex-col bg-surface-2 pt-(--title-band) ${PAGE_FRAME_CLASS}`}>
        {/* The bottom padding below `sm` keeps the last link's focus ring inside
            the scroll box, which clips it; above `sm` the collapse block does. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2 sm:pb-0">
          {/* The side padding sits on the lists, so the foot's border spans the
              sidebar's full width. */}
          <nav className="flex flex-1 flex-col pt-2">
            <ul className={LIST_CLASS}>
              {PRIMARY_NAVIGATION.map((entry) => (
                <SidebarLink key={entry.path} entry={entry} collapsed={collapsed} signal={signal} />
              ))}
            </ul>
            <ul className={`${LIST_CLASS} mt-auto border-t border-line`}>
              <UpdateItem collapsed={collapsed} />
              {FOOTER_NAVIGATION.map((entry) => (
                <SidebarLink key={entry.path} entry={entry} collapsed={collapsed} signal={signal} />
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
        </div>
      </div>
    </header>
  );
}
