const LABEL_CHARACTER = /^[a-z0-9-]$/;

const RULE = "Use lower-case letters, digits and dashes.";

type Fault
  = | { kind: "empty" }
    | { kind: "start" }
    | { kind: "end" }
    | { kind: "character"; character: string };

/** The engine's `labelFault`, run on the label as the daemon stores it: lower-cased before the check. */
function findFault(label: string): Fault | undefined {
  // Locale-independent, as the daemon's own conversion is.
  const stored = label.toLowerCase();

  if (stored === "") {
    return { kind: "empty" };
  }
  if (stored.startsWith("-")) {
    return { kind: "start" };
  }
  if (stored.endsWith("-")) {
    return { kind: "end" };
  }
  for (const character of stored) {
    if (!LABEL_CHARACTER.test(character)) {
      return { kind: "character", character };
    }
  }
  return undefined;
}

/** What is wrong with the form of a label, in the engine's words, or nothing. Upper case is no fault. */
export function labelFault(label: string): string | undefined {
  const fault = findFault(label);

  switch (fault?.kind) {
    case undefined:
      return undefined;
    case "empty":
      return "is empty";
    case "start":
      return 'starts with "-"';
    case "end":
      return 'ends with "-"';
    case "character":
      return `carries "${fault.character}"`;
  }
}

/** The sentence that tells a reader what is wrong with a label and what the rule is, or nothing. */
export function labelCorrection(label: string): string | undefined {
  const fault = findFault(label);

  switch (fault?.kind) {
    case undefined:
      return undefined;
    case "empty":
      return `A label cannot be empty. ${RULE}`;
    case "start":
      return `A label cannot start with a dash. ${RULE}`;
    case "end":
      return `A label cannot end with a dash. ${RULE}`;
    case "character":
      return `A label cannot carry "${fault.character}". ${RULE}`;
  }
}
