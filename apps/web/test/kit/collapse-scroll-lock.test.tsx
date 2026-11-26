import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningTrigger,
} from "@kit/components/assistant-ui/elements/reasoning.aui";
import {
  ToolFallbackContent,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from "@kit/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@kit/components/assistant-ui/elements/tool-group.aui";

afterEach(cleanup);

// The lock finds its viewport by the computed overflow, which jsdom reads from
// the inline style.
function ScrollBox({ children }: { children: ReactElement }) {
  return <div style={{ overflowY: "scroll" }}>{children}</div>;
}

const blocks = [
  {
    name: "tool output",
    trigger: /water_plants/,
    block: (open: boolean) => (
      <ToolFallbackRoot defaultOpen={open}>
        <ToolFallbackTrigger toolName="water_plants" />
        <ToolFallbackContent>Watered the ferns.</ToolFallbackContent>
      </ToolFallbackRoot>
    ),
  },
  {
    name: "tool group",
    trigger: /3 tool calls/,
    block: (open: boolean) => (
      <ToolGroupRoot defaultOpen={open}>
        <ToolGroupTrigger count={3} />
        <ToolGroupContent>Watered the ferns.</ToolGroupContent>
      </ToolGroupRoot>
    ),
  },
  {
    name: "reasoning block",
    trigger: /Reasoning/,
    block: (open: boolean) => (
      <ReasoningRoot defaultOpen={open}>
        <ReasoningTrigger />
        <ReasoningContent>The ferns need water first.</ReasoningContent>
      </ReasoningRoot>
    ),
  },
];

function scrollTopAfter(box: HTMLElement, change: () => void) {
  box.scrollTop = 100;
  change();
  box.scrollTop = 40;
  fireEvent.scroll(box);
  return box.scrollTop;
}

describe.each(blocks)("a $name", ({ trigger, block }) => {
  it("does not lock the scroll when it closes", () => {
    const { container } = render(<ScrollBox>{block(true)}</ScrollBox>);
    const box = container.firstElementChild as HTMLElement;
    const button = screen.getByRole("button", { name: trigger });

    const scrollTop = scrollTopAfter(box, () => fireEvent.click(button));

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(scrollTop).toBe(40);
  });

  it("locks the scroll when it opens", () => {
    const { container } = render(<ScrollBox>{block(false)}</ScrollBox>);
    const box = container.firstElementChild as HTMLElement;
    const button = screen.getByRole("button", { name: trigger });

    const scrollTop = scrollTopAfter(box, () => fireEvent.click(button));

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(scrollTop).toBe(100);
  });
});

describe("a streaming reasoning block", () => {
  const reasoning = (streaming: boolean) => (
    <ScrollBox>
      <ReasoningRoot streaming={streaming}>
        <ReasoningTrigger active={streaming} />
        <ReasoningContent>The ferns need water first.</ReasoningContent>
      </ReasoningRoot>
    </ScrollBox>
  );

  it("does not lock the scroll when streaming ends", () => {
    const { container, rerender } = render(reasoning(true));
    const box = container.firstElementChild as HTMLElement;

    const scrollTop = scrollTopAfter(box, () => rerender(reasoning(false)));

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(scrollTop).toBe(40);
  });

  it("locks the scroll when streaming starts", () => {
    const { container, rerender } = render(reasoning(false));
    const box = container.firstElementChild as HTMLElement;

    const scrollTop = scrollTopAfter(box, () => rerender(reasoning(true)));

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(scrollTop).toBe(100);
  });
});
