export const GROUP_CLASS = "inline-flex max-w-full min-w-0 items-center gap-2";

export const LABEL_CLASS = "text-xs-plus text-dim";

export const TRIGGER_CLASS
  = "inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-control border border-line bg-surface py-1 pr-2 pl-2.5 text-left text-sm text-text hover:border-graphic";

export const POPUP_CLASS = "rounded-card border border-line bg-surface p-1.5 shadow-float";

// For a menu root with `highlightItemOnHover={false}`: hover does not highlight
// an item, so the ring is never a hover mark. A mouse press focuses and
// highlights the item, so the ring is hidden while the button is held.
export const MENU_ITEM_CLASS
  = "flex min-h-8 items-center gap-2 rounded-control px-2 py-1 text-sm text-text hover:bg-surface-2 data-[highlighted]:bg-surface-2 data-[highlighted]:outline-3 data-[highlighted]:outline-offset-2 data-[highlighted]:outline-graphic data-[highlighted]:active:outline-hidden";

export const MENU_RADIO_ITEM_CLASS = `${MENU_ITEM_CLASS} data-[checked]:text-dim`;

export const POSITIONER_CLASS = "z-(--layer-popup)";
