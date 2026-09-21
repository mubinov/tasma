import { describe, expect, it } from "vitest";
import { labelCorrection, labelFault } from "../../src/lib/label-form";

const RULE = "Use lower-case letters, digits and dashes.";

describe("labelFault", () => {
  it.each(["a", "backend", "customer-request", "b2b", "0", "a--b", "1-2"])("accepts %s", (label) => {
    expect(labelFault(label)).toBeUndefined();
  });

  it.each([
    { label: "", fault: "is empty" },
    { label: "-a", fault: 'starts with "-"' },
    { label: "a-", fault: 'ends with "-"' },
    { label: "a_b", fault: 'carries "_"' },
    { label: "a:b", fault: 'carries ":"' },
    { label: "a/b", fault: 'carries "/"' },
    { label: "a.b", fault: 'carries "."' },
    { label: "ä", fault: 'carries "ä"' },
    { label: "customer request", fault: 'carries " "' },
  ])("rejects $label, naming what is wrong", ({ label, fault }) => {
    expect(labelFault(label)).toBe(fault);
  });

  // The daemon lower-cases a label before it checks the form.
  it.each(["Backend", "WEB", "B2B", "Customer-Request"])("accepts %s, which the daemon stores lower-cased", (label) => {
    expect(labelFault(label)).toBeUndefined();
  });

  it("names the first character that fails", () => {
    expect(labelFault("a b_c")).toBe('carries " "');
  });
});

describe("labelCorrection", () => {
  it.each([
    { label: "", correction: `A label cannot be empty. ${RULE}` },
    { label: "-a", correction: `A label cannot start with a dash. ${RULE}` },
    { label: "a-", correction: `A label cannot end with a dash. ${RULE}` },
    { label: "customer request", correction: `A label cannot carry " ". ${RULE}` },
    { label: "a_b", correction: `A label cannot carry "_". ${RULE}` },
  ])("answers one correction for $label", ({ label, correction }) => {
    expect(labelCorrection(label)).toBe(correction);
  });

  it("answers nothing for a label of the right form", () => {
    expect(labelCorrection("Backend")).toBeUndefined();
  });
});
