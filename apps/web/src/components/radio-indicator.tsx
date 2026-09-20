import { Menu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { CheckIcon } from "../lib/icons";

/**
 * The check of a menu radio item. It keeps its width while unchecked, so the
 * items of a menu stand in one column, and a plain `Menu.Item` beside them
 * holds the same width with a bare span.
 */
export function RadioIndicator(): ReactNode {
  return (
    <Menu.RadioItemIndicator keepMounted className="flex w-3.5 shrink-0 data-[unchecked]:invisible">
      <CheckIcon size={14} aria-hidden="true" />
    </Menu.RadioItemIndicator>
  );
}
