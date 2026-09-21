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

/*
 * Tailwind settles a conflict by the order of the rules in the generated sheet,
 * not by the order of the names in the class string, so the base carries no
 * colour and each class names its own border, fill and text colour.
 */
const CONTROL_BASE = "inline-flex min-h-8 items-center gap-1.5 rounded-control border text-sm";

export const BUTTON_CLASS = `${CONTROL_BASE} border-line bg-surface-2 px-3 text-text hover:border-graphic`;

export const BUTTON_QUIET_CLASS
  = `${CONTROL_BASE} border-transparent bg-transparent px-3 text-muted hover:border-line hover:text-text`;

// No hover mark, as drawn. Its keyboard state is the application's focus ring.
export const BUTTON_FILLED_CLASS = `${CONTROL_BASE} border-text bg-text px-3 text-bg`;

// A control using it carries a text accessible name and an aria-hidden icon.
export const ICON_BUTTON_CLASS
  = `${CONTROL_BASE} w-8 justify-center border-line bg-surface-2 text-dim hover:border-graphic hover:text-text`;

/*
 * A value of a definition list that opens a menu. Written out rather than laid
 * on `CONTROL_BASE`, whose `min-h-8` would make the row 32px tall, and it takes
 * no text colour: the value keeps the one the row gives it.
 *
 * 24x24 in both directions: the row's line box is 20px at `text-sm`, so the
 * height needs its own pair, and the negative margins are absorbed by the
 * grid's `gap-y-2.5`. `min-w-6` holds the width for a one-character value.
 */
export const PROPERTY_BUTTON_CLASS
  = "inline-flex max-w-full -my-0.5 -mx-2 min-h-6 min-w-6 items-center rounded-control border border-transparent px-2 text-left text-sm hover:border-line data-[popup-open]:border-graphic";

/*
 * The icon control that edits a value beside it. Written out for the reason
 * `PROPERTY_BUTTON_CLASS` is, and 24x24 on a 20px line box the same way. A
 * control using it carries a text accessible name and an aria-hidden icon.
 */
export const PENCIL_BUTTON_CLASS
  = "inline-flex size-6 -my-0.5 shrink-0 items-center justify-center rounded-control border border-transparent text-dim hover:border-line hover:text-text data-[popup-open]:border-graphic data-[popup-open]:text-text";

/*
 * The whole border rule of an editable field, less the radius, which differs
 * per caller. The border is the only thing that says the box is editable — the
 * text in it is the reader's own data, not a label — so it takes `graphic`,
 * which holds 3:1 in both themes, whether or not the field holds a value.
 * `line` would hold 1.27:1 against the field's own fill. A field marked as not
 * valid takes `signal` instead, and the two rules are mutually exclusive, so
 * the precedence is in the selector rather than in the generated sheet's order.
 */
export const FIELD_BORDER_CLASS = "border not-data-invalid:border-graphic data-invalid:border-signal";

// The margin is the caller's: an appended `mt-0` could not cancel one here.
// `flex-wrap` is here because the hint's row reflows at 320 CSS px.
export const FIELD_HINT_CLASS = "flex flex-wrap items-center gap-1.5 text-xs-plus text-dim";

export const FIELD_KBD_CLASS = "rounded-control border border-line bg-surface-2 px-1 font-mono text-xs";

export const FIELD_ERROR_CLASS = "mt-1.5 text-sm text-signal";

// One prop holds both a wait and a refusal, so the line takes no state colour.
export const DIALOG_STATUS_CLASS = "mt-4 text-sm font-medium text-muted wrap-anywhere";

export const DIALOG_BODY_CLASS = "mt-2 text-base text-muted wrap-anywhere";

export const DIALOG_SCRIM_CLASS = "fixed inset-0 z-(--layer-dialog) bg-scrim";

/*
 * `items-start` here with `my-auto` on the panel: while there is room the auto
 * margin wins over `align-items` and centres the panel, and once there is not
 * it resolves to zero. `items-center` instead puts the top of a tall panel past
 * the scroll origin, out of reach.
 */
export const DIALOG_VIEWPORT_CLASS
  = "fixed inset-0 z-(--layer-dialog) flex items-start justify-center overflow-y-auto p-4";

/*
 * A block container: `DIALOG_ACTIONS_CLASS` and `DIALOG_STATUS_CLASS` rely on
 * margin collapsing, which `flex flex-col` here would switch off.
 */
export const DIALOG_PANEL_CLASS
  = "my-auto w-full max-w-[420px] rounded-panel border border-line bg-surface px-6 pt-5 pb-6 shadow-float";

export const DIALOG_ACTIONS_CLASS = "mt-5 flex justify-end gap-2";
