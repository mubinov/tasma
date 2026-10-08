import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { POSITIONER_CLASS } from "./control-classes";

type TooltipProps = {
  children: ReactElement;
  content: ReactNode;
};

/**
 * Shows `content` below its trigger on pointer hover and on keyboard focus. The
 * content is visual only and no screen reader reads it, so each trigger must
 * have its own accessible name.
 */
export function Tooltip({ children, content }: TooltipProps): ReactNode {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="bottom" align="start" sideOffset={8} className={POSITIONER_CLASS}>
          <BaseTooltip.Popup className="max-w-md animate-enter rounded-card border border-line bg-surface px-2.5 py-1.5 text-xs-plus text-text shadow-float wrap-anywhere">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
