import { describe, expect, it, onTestFinished } from "vitest";
import { itemUrls, KIT_ITEMS, prepareItem, serveRegistry, type KitServer } from "../../scripts/kit/registry.ts";
import { put, scratch } from "./helpers.ts";

describe("itemUrls", () => {
  it("names the 8 kit items on the local server", () => {
    expect(KIT_ITEMS).toHaveLength(8);
    expect(itemUrls("http://127.0.0.1:4000")).toContain("http://127.0.0.1:4000/base/thread.json");
    expect(itemUrls("http://127.0.0.1:4000")).toHaveLength(8);
  });
});

describe("the rewrite of the built items", () => {
  const origin = "http://127.0.0.1:4000";

  it("points each link to the live registry at the local server", () => {
    const item = JSON.stringify({
      name: "panel",
      docs: "See https://r.assistant-ui.com/base/panel.json",
      registryDependencies: ["https://r.assistant-ui.com/base/badge.json"],
    });

    const prepared = JSON.parse(prepareItem(item, origin, new Set()).text) as Record<string, unknown>;

    expect(prepared.docs).toBe("See http://127.0.0.1:4000/base/panel.json");
    expect(prepared.registryDependencies).toEqual(["http://127.0.0.1:4000/base/badge.json"]);
  });

  it("serves a shadcn name with a saved file from the local server, and reports one without", () => {
    const item = JSON.stringify({
      name: "panel",
      registryDependencies: ["button", "@shadcn/avatar", "dialog", "@shadcn/tooltip"],
    });

    const prepared = prepareItem(item, origin, new Set(["button", "avatar"]));

    expect((JSON.parse(prepared.text) as { registryDependencies: string[] }).registryDependencies).toEqual([
      "http://127.0.0.1:4000/ui/button.json",
      "http://127.0.0.1:4000/ui/avatar.json",
      "dialog",
      "tooltip",
    ]);
    expect(prepared.fromShadcn).toEqual(["dialog", "tooltip"]);
    expect(prepared.foreign).toEqual([]);
  });

  it("reports each registry dependency that is not on the local server and not a shadcn name", () => {
    const foreign = [
      "@acme/chip",
      "https://ui.shadcn.com/r/styles/base-nova/badge.json",
      "https://r.example.com/base/badge.json",
      "http://127.0.0.1:4001/base/badge.json",
    ];
    const item = JSON.stringify({ name: "panel", registryDependencies: ["button", `${origin}/base/badge.json`, ...foreign] });

    expect(prepareItem(item, origin, new Set()).foreign).toEqual(foreign);
  });

  it("names the packages an item pins with a caret range, with the version of each pin", () => {
    const item = JSON.stringify({
      name: "panel",
      dependencies: ["@assistant-ui/react@^0.15.25", "lucide-react", "tw-shimmer@^0.4.13", "exact@1.0.0"],
    });

    expect(prepareItem(item, origin, new Set()).pinned).toEqual(
      new Map([["@assistant-ui/react", "0.15.25"], ["tw-shimmer", "0.4.13"]]),
    );
  });

  it("leaves an item with no dependencies of either kind as it is", () => {
    const prepared = prepareItem('{"name":"panel"}', origin, new Set());

    expect(prepared).toEqual({ text: '{"name":"panel"}', fromShadcn: [], foreign: [], pinned: new Map() });
  });
});

describe("serveRegistry", () => {
  async function start(): Promise<KitServer> {
    const dist = scratch();
    put(dist, "base/panel.json", JSON.stringify({
      name: "panel",
      dependencies: ["@assistant-ui/react@^0.15.25"],
      registryDependencies: ["button", "dialog", "https://r.assistant-ui.com/base/badge.json"],
    }));
    put(dist, "base/chip.json", JSON.stringify({
      name: "chip",
      dependencies: ["chip-core@^1.0.0"],
      registryDependencies: ["tooltip", "@acme/chip"],
    }));
    const server = await serveRegistry(dist, new Map([["button", "export const Button = 1;\n"]]));
    onTestFinished(() => server.close());
    return server;
  }

  it("serves a built item rewritten to its own address, and records what the item needs", async () => {
    const { origin, fromShadcn, pinned } = await start();

    const response = await fetch(`${origin}/base/panel.json`);
    const item = await response.json() as { registryDependencies: string[] };

    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(item.registryDependencies).toEqual([`${origin}/ui/button.json`, "dialog", `${origin}/base/badge.json`]);
    expect([...fromShadcn]).toEqual(["dialog"]);
    expect(pinned).toEqual(new Map([["@assistant-ui/react", "0.15.25"]]));
  });

  it("refuses an item that names a foreign registry dependency, and records the dependency alone", async () => {
    const { origin, fromShadcn, foreign, pinned } = await start();

    expect((await fetch(`${origin}/base/chip.json`)).status).toBe(409);
    expect([...foreign]).toEqual(["@acme/chip"]);
    expect([...fromShadcn]).toEqual([]);
    expect(pinned).toEqual(new Map());
  });

  it("serves a saved shadcn part as an item that holds the file text, and records it", async () => {
    const { origin, served } = await start();

    expect([...served]).toEqual([]);
    const item = await (await fetch(`${origin}/ui/button.json`)).json();

    expect(item).toEqual({
      name: "button",
      type: "registry:ui",
      files: [{ path: "components/ui/button.tsx", type: "registry:ui", content: "export const Button = 1;\n" }],
    });
    expect([...served]).toEqual(["button"]);
  });

  it("answers 404 for a part with no saved file, an item that does not exist and a path outside the folder", async () => {
    const { origin } = await start();

    for (const path of ["/ui/dialog.json", "/base/missing.json", "/base/..%2Fpanel.json", "/base/panel.txt"]) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(404);
    }
  });
});
