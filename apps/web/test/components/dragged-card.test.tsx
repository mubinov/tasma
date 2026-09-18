import type { TaskEntry } from "@tasma/protocol";
import { cleanup, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DraggedCard } from "../../src/components/dragged-card";
import type { StepView } from "../../src/lib/board";
import { entry } from "../card-fixture";
import { renderBesideTaskRoute } from "../helpers";

/** The card a drag carries renders on the body, outside the tree that holds it. */
async function renderLifted(task: TaskEntry = entry(), view: StepView = { kind: "none" }, top = false) {
  await renderBesideTaskRoute(
    <DraggedCard elementRef={createRef<HTMLDivElement>()} width={264} entry={task} view={view} top={top} />,
  );
  const wrapper = document.body.querySelector<HTMLElement>("[inert]")!;

  return { wrapper, card: wrapper.firstElementChild as HTMLElement };
}

afterEach(cleanup);

describe("the card a drag carries", () => {
  it("renders on the body at the width of the card it was lifted from, over every layer", async () => {
    const { wrapper } = await renderLifted();

    expect(wrapper.parentElement).toBe(document.body);
    expect(wrapper.style.width).toBe("264px");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.className).toContain("z-(--layer-drag)");
    expect(wrapper.className).toContain("shadow-float");
  });

  it("carries the graphic border, no control, and nothing that takes focus", async () => {
    const { wrapper, card } = await renderLifted();

    expect(card.className).toContain("border-graphic");
    expect(screen.queryByRole("button", { name: "Task menu" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(wrapper.querySelector("a, button, [tabindex]")).toBeNull();
    expect(wrapper.querySelector("[data-task-id]")).toBeNull();
  });

  it("draws the id, the title, the priority, the labels and the step the card draws", async () => {
    const { wrapper } = await renderLifted(
      entry({ priority: "high", labels: ["web"], workflow: "dev", step: "research" }, true),
      { kind: "step", name: "research", owner: "agent", current: 0, owners: ["agent", "human"] },
      true,
    );

    expect(wrapper.textContent).toContain("SAGA-7");
    expect(wrapper.textContent).toContain("Build the parser");
    expect(wrapper.textContent).toContain("blocked");
    expect(wrapper.textContent).toContain("high");
    expect(wrapper.textContent).toContain("web");
    expect(wrapper.textContent).toContain("research");
  });
});
