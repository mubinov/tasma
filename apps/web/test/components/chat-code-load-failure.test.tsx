import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatCode } from "../../src/components/chat-code";
import { plainComponents } from "../kit/shiki";

vi.mock(import("@kit/components/assistant-ui/elements/shiki-highlighter.aui"), () => {
  throw new Error("the chunk failed to load");
});

afterEach(() => {
  cleanup();
});

it("keeps the plain code when the highlighter fails to load", async () => {
  const { container } = render(<ChatCode components={plainComponents} language="ts" code="const total = 3;" />);
  const fallback = screen.getByTestId("plain");

  // The loaded component mounts a block of its own in place of the fallback.
  await waitFor(() => expect(screen.getByTestId("plain")).not.toBe(fallback));
  expect(screen.getByTestId("plain").textContent).toBe("const total = 3;");
  expect(container.querySelector("pre.shiki")).toBeNull();
});
