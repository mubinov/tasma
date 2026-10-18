import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backUp, clearKit, readTree, restore, shadcnParts, writeTree } from "../../scripts/kit/files.ts";
import { put, scratch } from "./helpers.ts";

describe("the kit folder", () => {
  it("reads as a map of relative paths, and as empty when it does not exist", () => {
    const root = scratch();
    put(root, "kit.css", "x");
    put(root, "components/ui/button.tsx", "y");

    expect(readTree(root)).toEqual(new Map([["components/ui/button.tsx", "y"], ["kit.css", "x"]]));
    expect(readTree(join(root, "missing"))).toEqual(new Map());
  });

  it("is refused when a file name holds a control character", () => {
    for (const name of ["thread\u001b[8m.tsx", "thread\n.tsx", "nested\r/thread.tsx"]) {
      const root = scratch();
      put(root, name, "x");

      expect(() => readTree(root), JSON.stringify(name)).toThrow(`holds a control character: ${JSON.stringify(name)}`);
    }
  });

  it("is written from a map of relative paths", () => {
    const root = scratch();

    writeTree(root, new Map([["src/kit/lib/utils.ts", "u"], ["package.json", "{}"]]));

    expect(readTree(root)).toEqual(new Map([["package.json", "{}"], ["src/kit/lib/utils.ts", "u"]]));
  });

  it("gives its saved shadcn parts by name", () => {
    const root = scratch();
    put(root, "components/ui/button.tsx", "b");
    put(root, "components/ui/notes.md", "n");
    put(root, "components/ui/nested/chip.tsx", "c");
    put(root, "components/assistant-ui/elements/thread.aui.tsx", "t");

    expect(shadcnParts(root)).toEqual(new Map([["button", "b"]]));
    expect(shadcnParts(join(root, "missing"))).toEqual(new Map());
  });

  it("is cleared down to lib/utils.ts and an empty kit.css", () => {
    const root = scratch();
    put(root, "kit.css", "@import \"tw-shimmer\";\n");
    put(root, "lib/utils.ts", "u");
    put(root, "lib/other.ts", "o");
    put(root, "components/ui/button.tsx", "b");

    clearKit(root);

    expect(readTree(root)).toEqual(new Map([["kit.css", ""], ["lib/utils.ts", "u"]]));
  });

  it("is created by the clear when it does not exist", () => {
    const root = join(scratch(), "kit");

    clearKit(root);

    expect(readTree(root)).toEqual(new Map([["kit.css", ""]]));
  });
});

describe("the backup", () => {
  it("puts each saved file and folder back as it was, and removes one that did not exist", () => {
    const root = scratch();
    const backup = join(scratch(), "backup");
    put(root, "kit/a.ts", "a");
    put(root, "package.json", "{}");
    const saved = [join(root, "kit"), join(root, "package.json"), join(root, "new.json")];

    backUp(saved, backup);
    put(root, "kit/a.ts", "changed");
    put(root, "kit/b.ts", "added");
    put(root, "package.json", '{"changed":true}');
    put(root, "new.json", "{}");
    restore(saved, backup);

    expect(readTree(root)).toEqual(new Map([["kit/a.ts", "a"], ["package.json", "{}"]]));
  });
});
