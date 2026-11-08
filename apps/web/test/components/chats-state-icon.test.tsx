import type { AgentState } from "@tasma/protocol";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatsStateIcon } from "../../src/components/chats-state-icon";

afterEach(cleanup);

function iconOf(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function layersOf(container: HTMLElement): HTMLElement[] {
  return [...iconOf(container).children] as HTMLElement[];
}

function animationsOf(element: HTMLElement): string[] {
  return [...element.classList].filter((name) => name.startsWith("animate-"));
}

describe("ChatsStateIcon", () => {
  it.each<[AgentState, string, number, string[][]]>([
    ["off", "text-graphic", 3, [[], [], []]],
    ["running", "text-running", 3, [["animate-chats-ripple-outer"], ["animate-chats-ripple-inner"], []]],
    ["needs-you", "text-signal", 2, [["animate-chats-glow"], ["animate-chats-breathe"]]],
  ])("draws %s with its colour, its layers and its motion", (state, colour, count, animations) => {
    const { container } = render(<ChatsStateIcon state={state} />);

    expect(iconOf(container).getAttribute("aria-hidden")).toBe("true");
    expect(iconOf(container).classList.contains(colour)).toBe(true);
    expect(layersOf(container)).toHaveLength(count);
    expect(layersOf(container).map(animationsOf)).toEqual(animations);
  });

  it.each<[AgentState, boolean]>([
    ["off", true],
    ["running", false],
    ["needs-you", false],
  ])("gives the lamp of %s a hollow shape: %s", (state, hollow) => {
    const { container } = render(<ChatsStateIcon state={state} />);
    const lamp = layersOf(container).at(-1)!;

    expect(lamp.classList.contains("bg-current")).toBe(!hollow);
    expect(lamp.classList.contains("border-[1.08px]")).toBe(hollow);
  });

  it.each<[AgentState, string[]]>([
    ["off", ["[--ring-outer:0.3]", "[--ring-inner:0.6]"]],
    ["running", ["[--ring-outer:0.3]", "[--ring-inner:0.6]"]],
    ["needs-you", ["[--ring-inner:0.45]"]],
  ])("sets the still opacity of the rings of %s, and full opacity under increased contrast", (state, rings) => {
    const { container } = render(<ChatsStateIcon state={state} />);
    const { classList } = iconOf(container);

    for (const name of [...rings, "contrast-more:[--ring-outer:1]", "contrast-more:[--ring-inner:1]"]) {
      expect(classList.contains(name), name).toBe(true);
    }
  });

  it("mounts new layers for a new state", () => {
    const { container, rerender } = render(<ChatsStateIcon state="running" />);
    const [outer] = layersOf(container);

    rerender(<ChatsStateIcon state="running" />);
    expect(layersOf(container)[0]).toBe(outer);

    rerender(<ChatsStateIcon state="off" />);
    expect(layersOf(container)[0]).not.toBe(outer);
  });

  it("stops each animated layer under reduced motion, and keeps a still layer plain", () => {
    const { container } = render(<ChatsStateIcon state="running" />);
    const [outer, inner, lamp] = layersOf(container);

    for (const layer of [outer!, inner!]) {
      expect(layer.classList.contains("motion-reduce:animate-none")).toBe(true);
      expect(layer.classList.contains("will-change-[transform,opacity]")).toBe(true);
    }
    expect(lamp!.classList.contains("motion-reduce:animate-none")).toBe(false);
    expect(lamp!.classList.contains("will-change-[transform,opacity]")).toBe(false);
  });

  it.each<AgentState>(["running", "needs-you"])("renders %s with no animation when stopped", (state) => {
    const { container } = render(<ChatsStateIcon state={state} still />);

    expect(layersOf(container).flatMap(animationsOf)).toEqual([]);
  });
});
