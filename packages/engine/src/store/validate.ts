import { labelFault } from "../format/schema.js";
import { fail } from "./errors.js";
import type { StoreDiagnostic } from "./types.js";

/**
 * The labels as they are stored. An uppercase letter is converted rather than
 * refused, because `Backend` and `backend` denote one label; a space or a
 * separator would be a guess about intent. Deduplication is unconditional: two
 * statements of one label store it once either way.
 */
export function validateLabels(value: unknown, path: string, diagnostics: StoreDiagnostic[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail("label-invalid", "labels must hold a list of strings", path);
  }
  const stored: string[] = [];
  for (const given of value as string[]) {
    // Locale-independent, so a Turkish locale cannot turn "I" into another letter.
    const label = given.toLowerCase();
    if (label !== given) {
      diagnostics.push({
        code: "label-case-converted",
        message: `the label "${given}" was stored as "${label}"`,
        path,
      });
    }
    const fault = labelFault(label);
    if (fault !== undefined) fail("label-invalid", `the label "${given}" ${fault}`, path);
    if (stored.includes(label)) {
      diagnostics.push({
        code: "label-duplicate-dropped",
        message: `the label "${label}" was stated more than once and is stored once`,
        path,
      });
      continue;
    }
    stored.push(label);
  }
  return stored;
}

/**
 * The declared member a value names. The test is membership rather than a
 * character rule, because these are display strings the user declares. A single
 * case-insensitive match is corrected and reported; lowercasing instead would be
 * wrong, because a declared list may legitimately carry `High`.
 */
export function validateMember(
  value: unknown,
  declared: string[],
  field: "status" | "priority",
  path: string,
  diagnostics: StoreDiagnostic[],
): string {
  const unknown = field === "status" ? "status-unknown" : "priority-unknown";
  if (typeof value !== "string") fail(unknown, `${field} must be a string, one of ${declared.join(", ")}`, path);
  if (declared.includes(value)) return value;
  const matches = declared.filter((member) => member.toLowerCase() === value.toLowerCase());
  if (matches.length > 1) {
    fail(unknown, `${field} "${value}" matches ${matches.join(" and ")}, which gives no basis to pick one`, path);
  }
  const match = matches[0];
  if (match === undefined) fail(unknown, `${field} "${value}" is not one of ${declared.join(", ")}`, path);
  diagnostics.push({
    code: field === "status" ? "status-case-corrected" : "priority-case-corrected",
    message: `${field} "${value}" was stored as the declared "${match}"`,
    path,
  });
  return match;
}
