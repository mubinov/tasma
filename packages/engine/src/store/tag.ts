import { basename } from "node:path";
import { fail } from "./errors.js";

/** The longest a tag may be, which is what limits the numbers a collision can try. */
const LONGEST = 8;

/**
 * The form a project is created under: a letter, then letters or digits, two to
 * `LONGEST` characters. It is narrower than `TAG_PATTERN`, the safety rule every
 * path is built under, so a directory a hand created under the wider rule stays
 * readable and removable while nothing new is registered outside this one.
 */
export const TAG_RULE = new RegExp(`^[A-Z][A-Z0-9]{1,${LONGEST - 1}}$`);

/** The rule in the words a refusal states it in, so the bound is written once. */
export const TAG_SHAPE = `a letter, then letters or digits, 2 to ${LONGEST} characters`;

/** True for a value that is a string and stands under the rule. */
export function isTag(value: unknown): value is string {
  // The type is tested first: a regular expression converts its argument, so an
  // array holding one matching string would otherwise pass.
  return typeof value === "string" && TAG_RULE.test(value);
}

/** The tag a caller stated, under the rule a project is created under. */
export function checkedTag(tag: unknown): string {
  if (isTag(tag)) return tag;
  fail("tag-invalid", `the project tag "${String(tag)}" must be ${TAG_SHAPE}`);
}

const OUTSIDE_TAG = /[^A-Z0-9]/g;
const LEADING_DIGITS = /^\d+/;

/** What a generated tag is cut to, which leaves a collision the rest of `LONGEST` to count with. */
const GENERATED_LENGTH = 4;

/**
 * The tag the last folder name of a path gives. Only the text is read: the path
 * is neither resolved nor opened, so this states what the caller's own words
 * come to and nothing about the disk.
 */
export function generateTag(path: string): string {
  const name = basename(path);
  const kept = name.toUpperCase().replace(OUTSIDE_TAG, "").replace(LEADING_DIGITS, "");
  if (kept === "") {
    fail("tag-not-generated", `no project tag can be made from the name "${name}", which holds no letter`);
  }
  const head = kept.slice(0, GENERATED_LENGTH);
  // One character is all that can be left here, so repeating the head is
  // repeating its last character.
  return head.length < 2 ? head.repeat(2) : head;
}

/**
 * The tag itself when nothing holds it, else the first `<tag><number>` from two
 * up that nothing holds. The number grows without limit in value while the whole
 * tag stays within the rule, so a tag whose numbers are all taken is refused.
 */
export function uniqueTag(tag: string, taken: ReadonlySet<string>): string {
  if (!taken.has(tag)) return tag;
  const limit = 10 ** (LONGEST - tag.length);
  for (let number = 2; number < limit; number += 1) {
    const candidate = `${tag}${number}`;
    if (!taken.has(candidate)) return candidate;
  }
  fail("project-exists", `every project tag from "${tag}" up is taken`);
}
