import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinkSettingsSync } from "../../src/components/link-settings-sync";
import { DEFAULT_LINK_SETTINGS } from "../../src/lib/link-settings";
import { useUiStore } from "../../src/store/ui";
import { stubShell } from "../helpers";

const SETTINGS = {
  browser: "com.example.browser",
  devBrowser: "com.example.dev-browser",
  devDomains: ["example.test"],
  fileApp: "com.example.editor",
};

function sentBodies(): unknown[] {
  return vi.mocked(fetch).mock.calls.map(([, init]) => init?.body);
}

beforeEach(() => {
  useUiStore.setState({ linkSettings: DEFAULT_LINK_SETTINGS });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("sends the stored settings at mount", async () => {
  const shell = stubShell();

  render(<LinkSettingsSync />);

  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/links"]);
  });
  expect(sentBodies()).toEqual([JSON.stringify(DEFAULT_LINK_SETTINGS)]);
});

it("sends changed settings", async () => {
  const shell = stubShell();
  render(<LinkSettingsSync />);
  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/links"]);
  });

  act(() => {
    useUiStore.getState().setLinkSettings(SETTINGS);
  });

  await waitFor(() => {
    expect(sentBodies()).toEqual([JSON.stringify(DEFAULT_LINK_SETTINGS), JSON.stringify(SETTINGS)]);
  });
});
