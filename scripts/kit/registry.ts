import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export const KIT_ITEMS = [
  "thread",
  "tool-fallback",
  "tool-group",
  "reasoning",
  "markdown-text",
  "elements-todo-list",
  "elements-terminal-block",
  "elements-code-diff",
  "shiki-highlighter",
] as const;

const LIVE_REGISTRY = "https://r.assistant-ui.com/";
const SHADCN_NAME = /^(?:@shadcn\/)?([a-z0-9][a-z0-9-]*)$/;
const CARET_PIN = /^(@?[^@]+)@\^(.+)$/;
// Each path segment is a plain name, so no request reaches outside the folder.
const ITEM_PATH = /^\/((?:[\w-]+\/)*[\w-]+\.json)$/;
const PART_PATH = /^\/ui\/([a-z0-9][a-z0-9-]*)\.json$/;

export function itemUrls(origin: string): string[] {
  return KIT_ITEMS.map((name) => `${origin}/base/${name}.json`);
}

type RegistryItem = { dependencies?: string[]; registryDependencies?: string[] };

/**
 * `pinned` maps each package that the item pins with a caret range to the
 * version of the pin. `foreign` lists the registry dependencies that are
 * neither on `origin` nor a shadcn name.
 */
export type PreparedItem = { text: string; fromShadcn: string[]; foreign: string[]; pinned: Map<string, string> };

/**
 * A built item as the local server gives it: links to the live registry point
 * to `origin`, and a shadcn name (`button` or `@shadcn/button`) with a saved
 * part points to that part on `origin`. A shadcn name with no saved part
 * becomes the bare name, so the CLI fetches it from ui.shadcn.com;
 * `fromShadcn` names it.
 */
export function prepareItem(text: string, origin: string, savedParts: ReadonlySet<string>): PreparedItem {
  const item = JSON.parse(text.replaceAll(LIVE_REGISTRY, `${origin}/`)) as RegistryItem;
  const fromShadcn: string[] = [];
  const foreign: string[] = [];

  if (item.registryDependencies !== undefined) {
    item.registryDependencies = item.registryDependencies.map((dependency) => {
      if (dependency.startsWith(`${origin}/`)) return dependency;
      const name = SHADCN_NAME.exec(dependency)?.[1];
      if (name === undefined) {
        foreign.push(dependency);
        return dependency;
      }
      if (savedParts.has(name)) return `${origin}/ui/${name}.json`;
      fromShadcn.push(name);
      return name;
    });
  }

  const pinned = new Map((item.dependencies ?? []).flatMap((dependency) => {
    const match = CARET_PIN.exec(dependency);
    return match === null ? [] : [[match[1]!, match[2]!] as const];
  }));

  return { text: JSON.stringify(item), fromShadcn, foreign, pinned };
}

/** The registry item of a saved shadcn part. The CLI writes it back to the same path with the same text. */
function partItem(name: string, content: string): string {
  const path = `components/ui/${name}.tsx`;
  return JSON.stringify({ name, type: "registry:ui", files: [{ path, type: "registry:ui", content }] });
}

export type KitServer = {
  origin: string;
  /** The bare shadcn names that the CLI fetches from ui.shadcn.com. */
  fromShadcn: Set<string>;
  /** The saved shadcn parts that the server gave to the CLI. */
  served: Set<string>;
  /** The registry dependencies outside the server and ui.shadcn.com. The server refuses each item that names one. */
  foreign: Set<string>;
  /** The packages that the served items pin with a caret range, with the version of the pin. */
  pinned: Map<string, string>;
  close(): Promise<void>;
};

/** Serves the items of `dist` and the saved shadcn `parts` on 127.0.0.1, on a port the system gives. */
export async function serveRegistry(dist: string, parts: ReadonlyMap<string, string>): Promise<KitServer> {
  const fromShadcn = new Set<string>();
  const served = new Set<string>();
  const foreign = new Set<string>();
  const pinned = new Map<string, string>();
  const savedParts = new Set(parts.keys());
  let origin = "";

  const server = createServer((request, response) => {
    const path = request.url ?? "";
    const part = PART_PATH.exec(path)?.[1];
    const item = ITEM_PATH.exec(path)?.[1];
    let status = 404;
    let body: string | undefined;

    if (part !== undefined) {
      const content = parts.get(part);
      if (content !== undefined) {
        served.add(part);
        body = partItem(part, content);
      }
    } else if (item !== undefined && existsSync(join(dist, item))) {
      const prepared = prepareItem(readFileSync(join(dist, item), "utf8"), origin, savedParts);
      prepared.foreign.forEach((dependency) => foreign.add(dependency));
      if (prepared.foreign.length > 0) {
        status = 409;
      } else {
        prepared.fromShadcn.forEach((name) => fromShadcn.add(name));
        prepared.pinned.forEach((version, name) => pinned.set(name, version));
        body = prepared.text;
      }
    }

    if (body === undefined) {
      response.writeHead(status).end();
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    fromShadcn,
    served,
    foreign,
    pinned,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
