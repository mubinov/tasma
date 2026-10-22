/*
 * The steps of the task page's top bar line while find is open, by container queries on the bar, whose width is the
 * line's. Each step applies only when the items of the step before it do not fit:
 *
 * 1. the find field goes from 15rem to 10rem, when the title would have less than about 6rem;
 * 2. the id and the title hide, and the field is 15rem again where that fits;
 * 3. Edit and the task menu hide, and the field is 15rem again where that fits;
 * 4. the back link hides, and the field takes the free width;
 * 5. the floor, when the field would be narrower than 10rem: the line padding, the gaps of the find group, of the field
 *    and before the toggle, the padding of the field and the step buttons shrink. At a 256 px line this leaves the
 *    counter room for five-digit numbers.
 *
 * Below the `sm` window width the line has its narrow padding and the back link its icon alone, so steps 3 and 4
 * apply at other widths there. The line is then at most 36rem wide, where steps 1 and 2 always apply. The widths are
 * the `--container-find-*` tokens of the theme.
 */

/** The classes of steps 1 to 4. */
export const FIND_OPEN_WIDTHS = {
  title: "max-sm:group-data-find-open/top-bar:hidden sm:@max-find-title:group-data-find-open/top-bar:hidden",
  actions: [
    "max-sm:@max-find-actions-below-sm:group-data-find-open/top-bar:hidden",
    "sm:@max-find-actions:group-data-find-open/top-bar:hidden",
  ].join(" "),
  back: "max-sm:@max-find-back-below-sm:group-data-find-open/top-bar:hidden sm:@max-find-back:group-data-find-open/top-bar:hidden",
  controls: [
    "max-sm:@max-find-back-below-sm:group-data-find-open/top-bar:min-w-0",
    "max-sm:@max-find-back-below-sm:group-data-find-open/top-bar:flex-1",
    "sm:@max-find-back:group-data-find-open/top-bar:min-w-0",
    "sm:@max-find-back:group-data-find-open/top-bar:flex-1",
  ].join(" "),
  group: "max-sm:@max-find-back-below-sm:flex-1 sm:@max-find-back:flex-1",
  field: [
    "max-sm:@min-find-actions-below-sm:w-40",
    "max-sm:@min-find-back-below-sm:@max-find-back-below-sm-wide:w-40",
    "max-sm:@max-find-back-below-sm:flex-1",
    "sm:@min-find-title:@max-find-title-wide:w-40",
    "sm:@min-find-actions:@max-find-actions-wide:w-40",
    "sm:@min-find-back:@max-find-back-wide:w-40",
    "sm:@max-find-back:flex-1",
  ].join(" "),
} as const;

/** The classes of step 5. */
export const FIND_OPEN_FLOOR = {
  line: "@max-find-floor:data-find-open:px-2",
  controls: "@max-find-floor:group-data-find-open/top-bar:gap-1",
  group: "@max-find-floor:gap-1",
  field: "@max-find-floor:gap-1 @max-find-floor:px-1",
  stepButton: "@max-find-floor:size-6",
} as const;
