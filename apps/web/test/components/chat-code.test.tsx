import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatCode } from "../../src/components/chat-code";
import { shikiClient } from "../../src/lib/shiki-client";
import { colouredTokens, plainComponents, SHIKI_LOAD } from "../kit/shiki";

vi.mock(import("shiki/langs"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    bundledLanguages: { ...actual.bundledLanguages, broken: () => Promise.reject(new Error("the chunk failed to load")) },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CODE = "// sum\nconst total = 1 + 2;\n";

it("shows the plain code first, then the code in Shiki colours that follow the theme", async () => {
  const { container } = render(<ChatCode components={plainComponents} language="ts" code={CODE} />);

  expect(container.querySelector("pre")!.textContent.trimEnd()).toBe(CODE.trimEnd());
  expect(colouredTokens(container)).toEqual([]);

  await waitFor(() => expect(colouredTokens(container).length).toBeGreaterThan(0), SHIKI_LOAD);
  const pre = container.querySelector("pre")!;
  expect(screen.queryByTestId("plain")).toBeNull();
  expect(colouredTokens(container).every((span) => span.style.color.startsWith("light-dark("))).toBe(true);
  expect(pre.textContent).toBe("// sum\nconst total = 1 + 2;");
  expect(pre.getAttribute("tabindex")).toBe("0");
});

it("keeps the indentation of the first code line, and drops the blank lines before it", async () => {
  const { container } = render(
    <ChatCode components={plainComponents} language="python" code={"\n  \n    def add(a, b):\n        return a + b\n"} />,
  );

  await waitFor(() => expect(colouredTokens(container).length).toBeGreaterThan(0), SHIKI_LOAD);
  expect(container.querySelector("pre")!.textContent).toBe("    def add(a, b):\n        return a + b");
});

it.each(["no-such-language", ""])("shows the code with no colours for the language %j", async (language) => {
  const error = vi.spyOn(console, "error");
  const { container } = render(<ChatCode components={plainComponents} language={language} code={CODE} />);

  await waitFor(() => expect(container.querySelector("pre[tabindex]")).not.toBeNull(), SHIKI_LOAD);
  expect(container.querySelector("pre")!.textContent).toBe("// sum\nconst total = 1 + 2;");
  expect(colouredTokens(container)).toEqual([]);
  expect(error).not.toHaveBeenCalled();
});

it("keeps the block plain when the worker gives it no colours", async () => {
  const highlight = vi.spyOn(shikiClient, "highlight");
  const { container } = render(<ChatCode components={plainComponents} language="broken" code={CODE} />);

  await waitFor(() => expect(highlight).toHaveBeenCalledOnce(), SHIKI_LOAD);
  await act(async () => {
    expect(await highlight.mock.results[0]!.value).toBeUndefined();
  });

  const pre = container.querySelector("pre")!;
  expect(pre.textContent).toBe("// sum\nconst total = 1 + 2;");
  expect(pre.hasAttribute("tabindex")).toBe(false);
  expect(colouredTokens(container)).toEqual([]);
});

// A line of 24 characters and its line break: 400 lines are 10,000 characters.
const LINE = "const total = 1 + 22; //\n";

it("colours a block of 10,000 characters, and shows a larger block plain", async () => {
  const atLimit = LINE.repeat(400);
  const overLimit = ` ${atLimit}`;
  render(
    <>
      <div data-testid="at-limit">
        <ChatCode components={plainComponents} language="ts" code={atLimit} />
      </div>
      <div data-testid="over-limit">
        <ChatCode components={plainComponents} language="ts" code={overLimit} />
      </div>
    </>,
  );

  await waitFor(() => expect(colouredTokens(screen.getByTestId("at-limit")).length).toBeGreaterThan(0), SHIKI_LOAD);
  const over = screen.getByTestId("over-limit");
  expect(within(over).getByTestId("plain").textContent).toBe(overLimit);
  expect(colouredTokens(over)).toEqual([]);
});
