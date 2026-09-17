import { expect, it } from "vitest";
import { heldBack, stubTransport, successReply } from "./helpers";

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

it("answers a write only under its method and path, and records each request with its body", async () => {
  const written = successReply({ id: "NOTE-1" });
  const { transport, requests } = stubTransport({ "PATCH /projects/NOTE/tasks/NOTE-1": written });

  const patch = await transport({ method: "PATCH", path: "/projects/NOTE/tasks/NOTE-1", body: { status: "Done" } });
  const get = await transport({ method: "GET", path: "/projects/NOTE/tasks/NOTE-1" });
  const unmapped = await transport({ method: "PATCH", path: "/projects" });

  expect(patch).toBe(written);
  expect(get.status).toBe(404);
  expect(unmapped.body).toMatchObject({ error: { message: "no route serves PATCH /projects" } });
  expect(requests).toEqual([
    { method: "PATCH", path: "/projects/NOTE/tasks/NOTE-1", body: { status: "Done" } },
    { method: "GET", path: "/projects/NOTE/tasks/NOTE-1" },
    { method: "PATCH", path: "/projects" },
  ]);
});

it("answers with a reply a test holds back until it resolves", async () => {
  const late = heldBack();
  const { transport } = stubTransport({ "/projects": late.reply });

  const reply = transport({ method: "GET", path: "/projects" });
  late.answer(successReply([]));

  expect(await reply).toEqual(successReply([]));
});
