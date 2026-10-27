import { Button } from "@base-ui/react/button";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { useImperativeHandle, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { CaretDownIcon, CircleNotchIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";
import { POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";

export type SplitButtonVariant = "outline" | "filled";

/*
 * Each part takes its look from the root's `data-variant`. Every look class
 * carries its variant, so the two looks never compete in the generated sheet.
 *
 * The menu part overlaps the action by 1px, so the two share one divider. The
 * part under the pointer, the open part and the focused part come to the top,
 * so the other part does not cover their border or their focus ring.
 */
const PART = "relative inline-flex min-h-8 items-center border text-sm focus-visible:z-2";

// The filled look has no hover mark, as `BUTTON_FILLED_CLASS`. Its focus ring
// has a gap of the page colour: on the seam, `focus` on the `text` fill of the
// other part is under 4.5:1.
const PART_LOOK = "group-data-[variant=outline]/split:border-line group-data-[variant=outline]/split:bg-surface-2 group-data-[variant=outline]/split:enabled:not-aria-disabled:hover:z-1 group-data-[variant=outline]/split:enabled:not-aria-disabled:hover:border-graphic group-data-[variant=filled]/split:border-text group-data-[variant=filled]/split:bg-text group-data-[variant=filled]/split:text-bg group-data-[variant=filled]/split:disabled:border-graphic group-data-[variant=filled]/split:disabled:bg-graphic group-data-[variant=filled]/split:focus-visible:outline-hidden group-data-[variant=filled]/split:focus-visible:ring-2 group-data-[variant=filled]/split:focus-visible:ring-focus group-data-[variant=filled]/split:focus-visible:ring-offset-2 group-data-[variant=filled]/split:focus-visible:ring-offset-bg";

const ACTION_CLASS = `${PART} ${PART_LOOK} gap-1.5 rounded-l-control pr-2.5 pl-3 group-data-[variant=outline]/split:text-text group-data-[variant=outline]/split:disabled:text-dim`;

// The filled divider is a `graphic` line on the seam, and the filled open mark
// a ring of the page colour.
const MENU_PART_CLASS = `${PART} ${PART_LOOK} -ml-px w-7 justify-center rounded-r-control group-data-[variant=outline]/split:text-dim group-data-[variant=outline]/split:enabled:not-aria-disabled:hover:text-text group-data-[variant=outline]/split:data-[popup-open]:z-1 group-data-[variant=outline]/split:data-[popup-open]:border-graphic group-data-[variant=outline]/split:data-[popup-open]:text-text group-data-[variant=filled]/split:before:absolute group-data-[variant=filled]/split:before:inset-y-1.5 group-data-[variant=filled]/split:before:-left-px group-data-[variant=filled]/split:before:w-px group-data-[variant=filled]/split:before:bg-graphic group-data-[variant=filled]/split:data-[popup-open]:inset-ring-2 group-data-[variant=filled]/split:data-[popup-open]:inset-ring-bg`;

type RootProps = {
  variant?: SplitButtonVariant;
  /**
   * Adds classes, for example for the place of the control. It cannot change
   * the colours or the size of a part: the order of the rules in the generated
   * sheet settles a conflict.
   */
  className?: string;
  /** One `Action`, then one `Menu`. */
  children: ReactNode;
};

/**
 * A main action, and a part that opens a menu of related actions. Use it as
 * `import * as SplitButton`.
 *
 * The two parts have no group role: a group of controls needs a visible label,
 * so the names of the parts carry the relation.
 */
export function Root({ variant = "outline", className = "", children }: RootProps): ReactNode {
  return (
    <div data-variant={variant} className={`group/split isolate inline-flex shrink-0 ${className}`}>
      {children}
    </div>
  );
}

type ActionProps = Omit<ComponentProps<typeof Button>, "className" | "disabled" | "focusableWhenDisabled"> & {
  /** An aria-hidden icon before the text. A busy action shows a spinner in its place. */
  icon?: ReactNode;
  /**
   * Keeps focus and does nothing. Give the same value to `Menu`. A screen
   * reader does not speak this change on the focused part, so while busy the
   * caller puts the wait in the name of the action and in the `label` of
   * `Menu`, and announces a wait that a press of the action starts. A wait
   * that a menu item starts needs no announcement: focus returns to the menu
   * part, whose `label` the reader speaks.
   */
  busy?: boolean;
  /**
   * Takes the part out of the tab order. Give the same value to `Menu`. After
   * a press or a chosen item, use `busy`: focus on a part that becomes
   * disabled is lost.
   */
  disabled?: boolean;
  /**
   * Adds classes, for example to hide the text in a narrow bar. It cannot
   * change the colours or the size of the part. A class that hides the text
   * needs an `aria-label`, or the button has no name.
   */
  className?: string;
};

/**
 * The main action. It takes every prop of a Base UI `Button`, so a caller can
 * give it a ref or wrap it in a `Tooltip`. An `aria-label` starts with the
 * visible text.
 */
export function Action({ icon, busy = false, disabled = false, className = "", children, ...props }: ActionProps): ReactNode {
  return (
    <Button
      type="button"
      {...props}
      disabled={disabled || busy}
      focusableWhenDisabled={busy}
      className={`${ACTION_CLASS} ${className}`}
    >
      {busy
        ? <CircleNotchIcon size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
        : icon}
      {children}
    </Button>
  );
}

type MenuProps = {
  /**
   * The name of the menu part, which shows only a caret. It names the action
   * that the menu extends: "More draft actions".
   */
  label: string;
  /** Keeps focus and does not open. Give the same value to `Action`, which states what the caller does while busy. */
  busy?: boolean;
  /**
   * Takes the part out of the tab order. Give the same value to `Action`.
   * After a chosen item, use `busy`: focus on a part that becomes disabled is
   * lost.
   */
  disabled?: boolean;
  /**
   * The menu part. Do not watch it with a `useFocusLost` of the caller: use
   * `onFocusLost`, or one loss of focus calls back twice.
   */
  ref?: Ref<HTMLButtonElement | null>;
  /** Called when the menu part leaves the page while it, or its open menu, holds focus. */
  onFocusLost?: () => void;
  /** `BaseMenu.Item`, `BaseMenu.Separator`, `BaseMenu.Group` and `BaseMenu.RadioGroup` elements. */
  children: ReactNode;
};

/**
 * The menu part and its menu, aligned to the right edge of the whole control.
 *
 * Base UI's menu trigger has no `focusableWhenDisabled`, so a busy trigger
 * stays enabled, which lets focus come back to it, and refuses to open.
 */
export function Menu({ label, busy = false, disabled = false, ref, onFocusLost, children }: MenuProps): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useImperativeHandle<HTMLButtonElement | null, HTMLButtonElement | null>(ref, () => triggerRef.current, []);
  useFocusLost(
    triggerRef,
    () => {
      onFocusLost?.();
    },
    open,
  );

  // Base UI calls onOpenChange only for a user action, so a menu that `busy`
  // closed would open again by itself when `busy` ends.
  if (open && (busy || disabled)) {
    setOpen(false);
  }

  return (
    <BaseMenu.Root
      highlightItemOnHover={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next && !busy && !disabled);
      }}
    >
      <BaseMenu.Trigger
        ref={triggerRef}
        aria-label={label}
        aria-disabled={busy || undefined}
        disabled={disabled}
        className={MENU_PART_CLASS}
      >
        <CaretDownIcon size={14} aria-hidden="true" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          anchor={() => triggerRef.current?.parentElement ?? null}
          align="end"
          sideOffset={4}
          className={POSITIONER_CLASS}
        >
          <BaseMenu.Popup className={`min-w-52 ${POPUP_CLASS}`}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
