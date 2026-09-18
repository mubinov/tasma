import { Form } from "@base-ui/react/form";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_HINT_CLASS } from "../../src/components/control-classes";
import { MarkdownEditor, MarkdownEditorHint, type MarkdownEditorProps } from "../../src/components/markdown-editor";

type EditorProps = Partial<MarkdownEditorProps> & { initialValue?: string };

/** Mounts the editor controlled, the way every caller uses it. */
function Editor({ initialValue = "", onValueChange, ...props }: EditorProps): ReactNode {
  const [value, setValue] = useState(initialValue);

  return (
    <MarkdownEditor
      label="Body"
      name="body"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
      {...props}
    />
  );
}

function control(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Body" });
}

/** The parts a control's aria-describedby names, in order. */
function describedBy(): (string | null)[] {
  const ids = control().getAttribute("aria-describedby")?.split(" ") ?? [];

  return ids.map((id) => document.getElementById(id)?.textContent ?? null);
}

afterEach(cleanup);

describe("the field", () => {
  it("names the control by a label that is hidden by sr-only, not by display", () => {
    render(<Editor />);

    const label = document.querySelector("label");
    expect(label?.textContent).toBe("Body");
    expect(label?.className).toContain("sr-only");
  });

  it("renders a textarea, not an input", () => {
    render(<Editor />);

    expect(control().tagName).toBe("TEXTAREA");
  });

  it("reports each change through onValueChange", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn<(value: string) => void>();
    render(<Editor onValueChange={onValueChange} />);

    await user.type(control(), "ab");

    expect(onValueChange.mock.calls.map(([value]) => value)).toEqual(["a", "ab"]);
  });

  it("takes the placeholder and never spell-checks, since the value is markdown source", () => {
    render(<Editor placeholder="Write the comment" />);

    expect(control().placeholder).toBe("Write the comment");
    expect(control().getAttribute("spellcheck")).toBe("false");
  });

  it("hands the ref the textarea, so a caller can move focus into the body", () => {
    function WithRef(): ReactNode {
      const ref = useRef<HTMLTextAreaElement>(null);

      return (
        <>
          <Editor ref={ref} />
          <button
            type="button"
            onClick={() => {
              ref.current?.focus();
            }}
          >
            Focus the body
          </button>
        </>
      );
    }
    render(<WithRef />);

    screen.getByRole("button", { name: "Focus the body" }).click();

    expect(document.activeElement).toBe(control());
  });

  it("puts className on the root and controlClassName on the textarea", () => {
    const { container } = render(<Editor className="max-w-2xl" controlClassName="min-h-[420px]" />);

    expect(container.firstElementChild?.className).toContain("max-w-2xl");
    expect(control().className).toContain("min-h-[420px]");
    expect(container.firstElementChild?.className).not.toContain("min-h-[420px]");
  });

  /*
   * jsdom implements no layout, so this asserts the class rather than the
   * growth, the same bargain contrast.test.ts strikes by reading the CSS text.
   */
  it("carries field-sizing-content, which is how it grows with its text", () => {
    render(<Editor />);

    expect(control().className).toContain("field-sizing-content");
  });
});

describe("the footer", () => {
  it("renders after the control and ties a hint built from the export to the field", () => {
    const { container, rerender } = render(<Editor footer={<MarkdownEditorHint>⌘↩ to save</MarkdownEditorHint>} />);

    const children = [...(container.firstElementChild?.children ?? [])];
    expect(children.indexOf(control())).toBeLessThan(children.length - 1);
    expect(children.at(-1)?.textContent).toBe("⌘↩ to save");
    expect(describedBy()).toEqual(["⌘↩ to save"]);

    rerender(<Editor footer={<MarkdownEditorHint>Esc to cancel</MarkdownEditorHint>} />);

    expect(describedBy()).toEqual(["Esc to cancel"]);
  });

  it("appends the hint's own class rather than substituting for it", () => {
    const { rerender } = render(
      <Editor footer={<MarkdownEditorHint className="flex-1">⌘↩ to save</MarkdownEditorHint>} />,
    );
    expect(screen.getByText("⌘↩ to save").className).toContain("flex-1");

    rerender(<Editor footer={<MarkdownEditorHint className="mt-2">⌘↩ to save</MarkdownEditorHint>} />);

    const hint = screen.getByText("⌘↩ to save");
    expect(hint.className).toContain("mt-2");
    expect(hint.className).not.toContain("flex-1");
    expect(hint.className).toContain(FIELD_HINT_CLASS);
  });
});

describe("the not-valid state", () => {
  it("marks the control and renders the line together, so the state never arrives without its text", () => {
    render(<Editor error="The body is too long" />);

    expect(control().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("The body is too long")).not.toBeNull();
  });

  it("lists the error beside the hint, both at the same time", () => {
    render(
      <Editor error="The body is too long" footer={<MarkdownEditorHint>⌘↩ to save</MarkdownEditorHint>} />,
    );

    expect(describedBy()).toEqual(["The body is too long", "⌘↩ to save"]);
  });

  /*
   * The empty-line case: `Field.Error` merges props by assignment, so a
   * `children: undefined` on the form path would write over Base UI's own
   * message and render an empty line.
   */
  it("marks nothing and renders no line with neither an error nor a form", () => {
    const { container } = render(<Editor footer={<MarkdownEditorHint>⌘↩ to save</MarkdownEditorHint>} />);

    expect(control().getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).toBe("Body⌘↩ to save");
  });

  it("carries data-filled only once it holds a value", () => {
    render(<Editor />);
    expect(control().hasAttribute("data-filled")).toBe(false);

    cleanup();
    render(<Editor initialValue="A body" />);

    expect(control().hasAttribute("data-filled")).toBe(true);
  });

  it("keeps the graphic border once it holds a value", () => {
    render(<Editor initialValue="A body" />);

    // The border is the only thing marking the box editable, so nothing scopes
    // it to an empty field.
    expect(control().className).toContain("not-data-invalid:border-graphic");
    expect(control().className).not.toContain("not-data-filled:");
  });

  it("resolves a field that is not valid to the signal border, not the graphic one", () => {
    render(<Editor error="The body is required" />);

    expect(control().hasAttribute("data-invalid")).toBe(true);
    // jsdom resolves no CSS, so the precedence is read from the selector the
    // class compiles to: the graphic rule is scoped with not-data-invalid:,
    // which makes the two rules mutually exclusive rather than equal in
    // specificity.
    expect(control().className).toContain("not-data-invalid:border-graphic");
    expect(control().className).toContain("data-invalid:border-signal");
  });

  it("takes a form error keyed by its name, and the next keystroke clears it", async () => {
    const user = userEvent.setup();
    render(
      <Form errors={{ body: "The daemon refused the body" }}>
        <Editor />
      </Form>,
    );
    expect(control().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("The daemon refused the body")).not.toBeNull();

    await user.type(control(), "a");

    expect(control().getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("The daemon refused the body")).toBeNull();
  });
});
