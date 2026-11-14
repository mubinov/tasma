import { afterEach, expect, it, vi } from "vitest";
import { sendWindowTheme, windowThemeAvailable } from "../../src/api/window-theme";
import { THEME_PREFERENCES } from "../../src/lib/theme-preference";
import { stubShell } from "../helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(THEME_PREFERENCES)("posts the setting %s to the app", async (preference) => {
  const shell = stubShell();

  await sendWindowTheme(preference);

  expect(shell.posted()).toEqual([`POST /app/theme/${preference}`]);
});

it("ignores a request the app does not answer", async () => {
  stubShell(() => Promise.reject(new TypeError("Load failed")));

  await expect(sendWindowTheme("dark")).resolves.toBeUndefined();
});

it("ignores a request the app refuses", async () => {
  stubShell(() => Promise.resolve(new Response(null, { status: 500 })));

  await expect(sendWindowTheme("dark")).resolves.toBeUndefined();
});

it("starts a send only after the previous one has settled", async () => {
  const answers: ((answer: Response) => void)[] = [];
  const shell = stubShell(() => new Promise((resolve) => answers.push(resolve)));

  const first = sendWindowTheme("light");
  const second = sendWindowTheme("dark");
  await vi.waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/theme/light"]);
  });

  answers[0]!(new Response(null, { status: 202 }));
  await first;
  await vi.waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/theme/light", "POST /app/theme/dark"]);
  });

  answers[1]!(new Response(null, { status: 202 }));
  await second;
});

it("sends the next setting after a send that failed", async () => {
  const shell = stubShell(() => Promise.reject(new TypeError("Load failed")));

  void sendWindowTheme("light");
  await sendWindowTheme("system");

  expect(shell.posted()).toEqual(["POST /app/theme/light", "POST /app/theme/system"]);
});

it("is available only on the origin the macOS app serves", () => {
  vi.stubGlobal("location", { protocol: "tasma-app:" });
  expect(windowThemeAvailable()).toBe(true);

  vi.stubGlobal("location", { protocol: "http:" });
  expect(windowThemeAvailable()).toBe(false);
});
