import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CodeDiff } from "@kit/components/assistant-ui/elements/code-diff";

afterEach(cleanup);

// The kit reaches Tasma code only through the @kit alias, which Vite and
// TypeScript resolve each on their own.
it("renders a kit view through the @kit alias", () => {
  render(
    <CodeDiff
      filename="garden/plan.txt"
      additions={1}
      deletions={1}
      cycle={0}
      lines={[
        { kind: "removed", text: "plant the tulips" },
        { kind: "added", text: "plant the crocuses" },
      ]}
    />,
  );

  expect(screen.getByText("garden/plan.txt")).toBeDefined();
  expect(screen.getByText("plant the tulips")).toBeDefined();
  expect(screen.getByText("plant the crocuses")).toBeDefined();
});
