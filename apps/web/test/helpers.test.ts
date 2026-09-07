import { expect, it } from "vitest";
import { stubTransport } from "./helpers";

/*
 * What a test that reaches a path it never mapped is answered with. Without the
 * arm the transport would resolve to nothing and the client would read an
 * envelope that is not there, which says nothing about the missing entry.
 */
it("refuses a path the stub map does not answer, naming it", async () => {
  const { transport, paths } = stubTransport();

  const reply = await transport({ method: "GET", path: "/projects/NONE" });

  expect(reply).toEqual({
    status: 404,
    body: { ok: false, error: { kind: "daemon", code: "route-not-found", message: "no route serves /projects/NONE" } },
  });
  expect(paths).toEqual(["/projects/NONE"]);
});
