import { act, cleanup, renderHook, type RenderHookResult } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useNewChatOptionPicks,
  type NewChatOption,
  type NewChatOptionPicks,
  type NewChatOptionPicksInput,
} from "../../src/lib/use-new-chat-option-picks";
import { modelOption, modeOption } from "../chat-fixtures";

afterEach(() => {
  cleanup();
});

const LIST = [modelOption("default"), modeOption("auto")];

/** The list after a change that drops Model B. */
const NO_MODEL_B = [modelOption("default", [{ value: "default", name: "Default" }, { value: "model-c", name: "Model C" }]), modeOption("auto")];

/** The list after a change that drops the model option. */
const NO_MODEL = [modeOption("auto")];

const BASE: NewChatOptionPicksInput = { agent: "claude", configOptions: LIST, sent: null };

type Rendered = RenderHookResult<NewChatOptionPicks, NewChatOptionPicksInput>;

function render(input: Partial<NewChatOptionPicksInput> = {}): Rendered {
  return renderHook((props) => useNewChatOptionPicks(props), { initialProps: { ...BASE, ...input } });
}

/** The shown value of each picker, by option id. */
function shown(options: readonly NewChatOption[]): Record<string, string> {
  return Object.fromEntries(options.map((option) => [option.shown.id, option.shown.current]));
}

function pick({ result }: Rendered, configId: string, value: string): void {
  act(() => {
    result.current.pick(result.current.options.find(({ listed }) => listed.id === configId)!, value);
  });
}

describe("useNewChatOptionPicks", () => {
  it("gives no pickers while no read has given a list", () => {
    const { result } = render({ configOptions: undefined });

    expect(result.current).toMatchObject({ options: [], dropped: null, changed: undefined });
  });

  it("gives Mode and Model in this order, each with its start value, and hides plan", () => {
    const { result } = render();

    expect(result.current.options.map(({ listed }) => listed.id)).toEqual(["mode", "model"]);
    expect(shown(result.current.options)).toEqual({ mode: "auto", model: "default" });
    expect(result.current.options.map(({ hidden }) => hidden)).toEqual([["plan"], []]);
    expect(result.current.changed).toBeUndefined();
  });

  it("shows a pick and gives it as changed, and a pick of the start value removes it", () => {
    const rendered = render();

    pick(rendered, "model", "model-b");
    expect(shown(rendered.result.current.options)).toEqual({ mode: "auto", model: "model-b" });
    expect(rendered.result.current.options[1]?.listed.current).toBe("default");
    expect(rendered.result.current.changed).toEqual({ model: "model-b" });

    pick(rendered, "model", "default");
    expect(shown(rendered.result.current.options)).toEqual({ mode: "auto", model: "default" });
    expect(rendered.result.current.changed).toBeUndefined();
  });

  it("keeps an offered pick at a change of the list, drops another and gives words for it", () => {
    const rendered = render();
    pick(rendered, "model", "model-b");
    pick(rendered, "mode", "acceptEdits");

    rendered.rerender({ ...BASE, configOptions: NO_MODEL_B });

    expect(shown(rendered.result.current.options)).toEqual({ mode: "acceptEdits", model: "default" });
    expect(rendered.result.current.dropped).toEqual({ words: ["Model B is not offered anymore. Model: Default."] });
    expect(rendered.result.current.changed).toEqual({ mode: "acceptEdits" });
  });

  it("names the option alone for a pick whose option leaves the row", () => {
    const rendered = render();
    pick(rendered, "model", "model-b");

    rendered.rerender({ ...BASE, configOptions: NO_MODEL });

    expect(shown(rendered.result.current.options)).toEqual({ mode: "auto" });
    expect(rendered.result.current.dropped).toEqual({ words: ["Model is not offered anymore."] });
  });

  it("drops nothing at a change of the list that offers every pick", () => {
    const rendered = render();
    pick(rendered, "mode", "acceptEdits");

    rendered.rerender({ ...BASE, configOptions: NO_MODEL_B });

    expect(shown(rendered.result.current.options)).toEqual({ mode: "acceptEdits", model: "default" });
    expect(rendered.result.current.dropped).toBeNull();
  });

  it("shows the values of a start that waits, and drops a pick only after the wait", () => {
    const rendered = render();
    pick(rendered, "model", "model-b");
    rendered.rerender({ ...BASE, sent: { model: "model-b" } });

    rendered.rerender({ ...BASE, configOptions: NO_MODEL_B, sent: { model: "model-b" } });
    expect(shown(rendered.result.current.options)).toEqual({ mode: "auto", model: "model-b" });
    expect(rendered.result.current.dropped).toBeNull();

    rendered.rerender({ ...BASE, configOptions: NO_MODEL_B });
    expect(shown(rendered.result.current.options)).toEqual({ mode: "auto", model: "default" });
    expect(rendered.result.current.dropped).toEqual({ words: ["Model B is not offered anymore. Model: Default."] });
  });

  it("takes the picks of the start that waits when it mounts during the wait", () => {
    const sent = { mode: "acceptEdits", model: "model-b" };
    const rendered = render({ sent });

    rendered.rerender(BASE);
    expect(shown(rendered.result.current.options)).toEqual(sent);
    expect(rendered.result.current.changed).toEqual(sent);

    rendered.rerender({ ...BASE, configOptions: NO_MODEL_B });
    expect(rendered.result.current.dropped).toEqual({ words: ["Model B is not offered anymore. Model: Default."] });
  });

  it("checks the picks of the start that waits against the list of the mount when the wait ends", () => {
    const rendered = render({ configOptions: NO_MODEL_B, sent: { mode: "acceptEdits", model: "model-b" } });

    rendered.rerender({ ...BASE, configOptions: NO_MODEL_B });

    expect(shown(rendered.result.current.options)).toEqual({ mode: "acceptEdits", model: "default" });
    expect(rendered.result.current.dropped).toEqual({ words: ["model-b is not offered anymore. Model: Default."] });
    expect(rendered.result.current.changed).toEqual({ mode: "acceptEdits" });

    rendered.rerender({ ...BASE, configOptions: LIST });
    expect(shown(rendered.result.current.options)).toEqual({ mode: "acceptEdits", model: "default" });
  });

  it("names the picks of the start that waits by their ids when it mounts with no list", () => {
    const rendered = render({ configOptions: undefined, sent: { mode: "acceptEdits", model: "model-b" } });

    rendered.rerender({ ...BASE, configOptions: [modelOption("default", [{ value: "default", name: "Default" }])] });

    expect(rendered.result.current.dropped).toEqual({
      words: ["mode is not offered anymore.", "model-b is not offered anymore. Model: Default."],
    });
  });
});
