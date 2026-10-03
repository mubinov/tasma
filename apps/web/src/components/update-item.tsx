import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { updateQuery, type Update } from "../api/queries";
import {
  ArrowCircleUpIcon,
  ArrowClockwiseIcon,
  CircleNotchIcon,
  WarningIcon,
  type IconComponent,
} from "../lib/icons";
import { useUiStore, type UpdateDialog } from "../store/ui";
import { CollapsingLabel, ICON_BOX_CLASS, ROW_CLASS } from "./sidebar-row";

const SIGNAL_CLASS = "text-signal hover:bg-surface";

type Look = { icon: IconComponent; label: string; className: string; dialog?: UpdateDialog["kind"] };

function look(update: Update): Look | null {
  switch (update.state) {
    case "available":
      return { icon: ArrowCircleUpIcon, label: `Update to ${update.version}`, className: SIGNAL_CLASS, dialog: "update" };
    case "installing":
      return { icon: CircleNotchIcon, label: `Installing ${update.version}`, className: "text-dim" };
    case "ready":
      return { icon: ArrowClockwiseIcon, label: "Restart to update", className: SIGNAL_CLASS, dialog: "restart" };
    case "failed":
      return { icon: WarningIcon, label: "Update failed", className: SIGNAL_CLASS, dialog: "failure" };
    default:
      return null;
  }
}

/**
 * The sidebar row of an update, above Settings. It stays a focusable button in
 * every state it shows, so focus on it stays when the state changes.
 */
export function UpdateItem({ collapsed }: { collapsed: boolean }): ReactNode {
  // The shell renders the sidebar wherever the router does, provider or not.
  const { queryClient } = useRouter().options.context;
  const { data: update } = useQuery(updateQuery(), queryClient);

  if (update === undefined || update === null) {
    return null;
  }

  const shown = look(update);
  if (shown === null) {
    return null;
  }

  const Icon = shown.icon;
  const dialog = shown.dialog;

  return (
    <li className="relative">
      <button
        type="button"
        aria-disabled={dialog === undefined ? true : undefined}
        onClick={(event) => {
          if (dialog !== undefined) {
            useUiStore.getState().openUpdateDialog({ kind: dialog, returnTo: event.currentTarget });
          }
        }}
        className={`${ROW_CLASS} ${shown.className}`}
      >
        <span className={ICON_BOX_CLASS}>
          <Icon size={20} aria-hidden="true" />
        </span>
        <CollapsingLabel collapsed={collapsed} className="text-sm">
          {shown.label}
        </CollapsingLabel>
      </button>
      {/* Outside the button, so its name does not change at each percent and
          holds all of its visible text. */}
      {update.state === "installing" && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
          <CollapsingLabel collapsed={collapsed} className="text-sm text-dim">
            {`${String(update.progress)}%`}
          </CollapsingLabel>
        </span>
      )}
    </li>
  );
}
