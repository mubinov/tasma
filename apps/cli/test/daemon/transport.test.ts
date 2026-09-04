import { DEFAULT_DAEMON_URL } from "@tasma/protocol";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { createFetchTransport, RequestTimeoutError, resolveDaemonUrl } from "../../src/daemon/transport.js";
import { startServer } from "../helpers.js";

describe("resolveDaemonUrl", () => {
  it("takes the flag first, the variable next and the built-in default last", () => {
    expect(resolveDaemonUrl("http://localhost:9000", { TASMA_DAEMON_URL: "http://127.0.0.1:9001" }))
      .toBe("http://localhost:9000");
    expect(resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: "http://127.0.0.1:9001" })).toBe("http://127.0.0.1:9001");
    expect(resolveDaemonUrl(undefined, {})).toBe(DEFAULT_DAEMON_URL);
  });

  // Without this, `${base}${path}` produces //health.
  it("keeps the origin alone, so a trailing slash, a case and a redundant :80 all normalise away", () => {
    expect(resolveDaemonUrl("http://127.0.0.1:9000/", {})).toBe("http://127.0.0.1:9000");
    expect(resolveDaemonUrl("HTTP://LOCALHOST:9000", {})).toBe("http://localhost:9000");
    expect(resolveDaemonUrl("http://127.0.0.1:80", {})).toBe("http://127.0.0.1");
  });

  // URL.hostname reports an IPv6 literal with its brackets, so a set written
  // from the prose alone would refuse an address the daemon does serve.
  it("accepts the bracketed IPv6 loopback literal", () => {
    expect(resolveDaemonUrl("http://[::1]:8278", {})).toBe("http://[::1]:8278");
  });

  it("refuses a value that is not a URL, through either channel", () => {
    expect(() => resolveDaemonUrl("nonsense", {})).toThrow(/nonsense/);
    expect(() => resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: "nonsense" })).toThrow(/nonsense/);
  });

  it("refuses a host that is not loopback, through either channel", () => {
    expect(() => resolveDaemonUrl("http://somewhere.example", {})).toThrow(/somewhere\.example/);
    expect(() => resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: "http://10.0.0.1:8278" })).toThrow(/10\.0\.0\.1/);
  });

  it("refuses a scheme the daemon does not speak, through either channel", () => {
    expect(() => resolveDaemonUrl("https://127.0.0.1:8278", {})).toThrow(/https/);
    expect(() => resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: "https://localhost:8278" })).toThrow(/https/);
  });

  // An exported-but-empty variable is an ordinary shell and CI shape, and a
  // message naming no address gives the reader nothing to act on.
  it("takes an empty value as unset, through either channel", () => {
    expect(resolveDaemonUrl("", {})).toBe(DEFAULT_DAEMON_URL);
    expect(resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: "" })).toBe(DEFAULT_DAEMON_URL);
    expect(resolveDaemonUrl("", { TASMA_DAEMON_URL: "http://127.0.0.1:9001" })).toBe("http://127.0.0.1:9001");
  });

  // A refusal reaches a CI log, scrollback or a pasted report, and an address
  // copied from a tunnel recipe carries a token in its userinfo.
  it("quotes a refused address back without its credentials", () => {
    expect(() => resolveDaemonUrl("https://user:token@127.0.0.1:8278", {})).toThrow(/https:\/\/127\.0\.0\.1:8278$/);
    expect(() => resolveDaemonUrl("https://user:token@127.0.0.1:8278", {})).not.toThrow(/token/);
  });

  // A scheme with no authority is followed by an opaque path, which is the
  // value's own and can carry anything.
  it("quotes the scheme alone for a value that parsed to no host", () => {
    expect(() => resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: "user:token@nowhere" })).toThrow(/localhost: user:$/);
  });

  // A `/` is legal in a base64 secret and illegal in userinfo, so an unparsable
  // value carrying an `@` has no boundary to trust in either direction: cutting
  // the path first quotes `user:aB3`, cutting the userinfo first quotes the
  // token behind the path.
  it("quotes the scheme alone when an unparsable value carries an @", () => {
    for (const stated of ["http://user:aB3/xY9z@127.0.0.1:8278", "http://127.0.0.1:99999/callback@SECRETVALUE"]) {
      expect(() => resolveDaemonUrl(stated, {})).toThrow(/^not a daemon address: http:\/\/$/);
      expect(() => resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: stated })).toThrow(/^not a daemon address: http:\/\/$/);
    }
  });

  // `#` and `?` are ordinary password characters, so the `@` is looked for over
  // the whole remainder: cutting the query and the fragment away first takes
  // the delimiter with them and quotes the userinfo in full.
  it("quotes the scheme alone when an unparsable value carries an @ behind a ? or a #", () => {
    for (const stated of ["http://user:SECRETVALUE#x@127.0.0.1:99999", "http://user:SECRETVALUE?x@127.0.0.1:99999"]) {
      expect(() => resolveDaemonUrl(stated, {})).toThrow(/^not a daemon address: http:\/\/$/);
      expect(() => resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: stated })).toThrow(/^not a daemon address: http:\/\/$/);
    }
  });

  // A backslash separates a path from the host for a special scheme, so it ends
  // the authority exactly as a slash does.
  it("ends an unparsable value's host at a backslash as it does at a slash", () => {
    expect(() => resolveDaemonUrl("http://127.0.0.1:99999\\SECRETVALUE", {})).toThrow(
      /^not a daemon address: http:\/\/127\.0\.0\.1:99999$/,
    );
  });

  // With no scheme either there is nothing left to show, so the line names the
  // fault and quotes none of the value.
  it("quotes nothing from an unparsable value that carries an @ and no scheme", () => {
    expect(() => resolveDaemonUrl("127.0.0.1:99999/callback@SECRETVALUE", {})).toThrow(/^not a daemon address$/);
  });

  // The scheme and the host decide the refusal; a path, a query and a fragment
  // decide no part of it, and a refused address is a tunnel or proxy recipe,
  // which is where a token rides.
  it("quotes the scheme and the host back and nothing behind them, parsable or not", () => {
    for (const stated of [
      "https://tunnel.example/?access_token=SECRETVALUE",
      "https://tunnel.example/#access_token=SECRETVALUE",
      "https://tunnel.example/services/SECRETVALUE",
    ]) {
      expect(() => resolveDaemonUrl(undefined, { TASMA_DAEMON_URL: stated })).toThrow(/tunnel\.example$/);
      expect(() => resolveDaemonUrl(stated, {})).not.toThrow(/SECRETVALUE/);
    }

    // An invalid port is the unparsable half of the same shape.
    expect(() => resolveDaemonUrl("http://127.0.0.1:99999/?token=SECRETVALUE", {}))
      .toThrow("not a daemon address: http://127.0.0.1:99999");
    expect(() => resolveDaemonUrl("http://127.0.0.1:99999/services/SECRETVALUE", {})).not.toThrow(/SECRETVALUE/);
  });

  // The refusal is a line in a log, not a payload, and no host anybody typed
  // runs to kilobytes.
  it("caps how much of a refused address it quotes back", () => {
    const long = `https://${"a".repeat(5000)}.example`;

    expect(() => resolveDaemonUrl(long, {})).toThrow(/a\.\.\.$/);
    expect(() => resolveDaemonUrl(long, {})).not.toThrow(long);
  });
});

type Seen = { method?: string; url?: string; contentType?: string; body: string };

async function collect(request: IncomingMessage): Promise<Seen> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return {
    method: request.method,
    url: request.url,
    contentType: request.headers["content-type"],
    body: Buffer.concat(chunks).toString(),
  };
}

describe("createFetchTransport", () => {
  it("sends no content type without a body and the JSON body with one when there is", async () => {
    const seen: Seen[] = [];
    const server = await startServer((request, response) => {
      void collect(request).then((entry) => {
        seen.push(entry);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: null, diagnostics: [] }));
      });
    });

    try {
      const transport = createFetchTransport(server.url);
      await transport({ method: "GET", path: "/health" });
      await transport({ method: "POST", path: "/projects/x/tasks", body: { title: "t" } });
    } finally {
      await server.close();
    }

    expect(seen[0]).toMatchObject({ method: "GET", url: "/health", contentType: undefined, body: "" });
    expect(seen[1]).toMatchObject({
      method: "POST",
      url: "/projects/x/tasks",
      contentType: "application/json",
      body: JSON.stringify({ title: "t" }),
    });
  });

  it("returns a refusal's status and envelope rather than throwing", async () => {
    const body = { ok: false, error: { kind: "store", code: "task-not-found", message: "no such task" } };
    const server = await startServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });

    try {
      const reply = await createFetchTransport(server.url)({ method: "GET", path: "/health" });
      expect(reply).toEqual({ status: 404, body });
    } finally {
      await server.close();
    }
  });

  // A proxy with nothing behind it answers HTML; swallowed, that reaches the
  // client as "answered with no envelope" rather than "reached no daemon".
  it("reads a body that is not JSON as no body at all", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<html>bad gateway</html>");
    });

    try {
      const reply = await createFetchTransport(server.url)({ method: "GET", path: "/health" });
      expect(reply).toEqual({ status: 502, body: undefined });
    } finally {
      await server.close();
    }
  });

  it("gives up on a server that accepts the request and never answers", async () => {
    const server = await startServer(() => {});

    try {
      await expect(createFetchTransport(server.url, 50)({ method: "GET", path: "/health" }))
        .rejects.toMatchObject({ timeoutMs: 50 });
    } finally {
      await server.close();
    }
  });

  // The budget covers the body too, so a stall after the headers is the budget
  // running out rather than a body that is not JSON.
  it("gives up on a server that answers its headers and stalls mid-body", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true,');
    });

    try {
      await expect(createFetchTransport(server.url, 50)({ method: "GET", path: "/health" }))
        .rejects.toBeInstanceOf(RequestTimeoutError);
    } finally {
      await server.close();
    }
  });

  // The loopback-only rule governs the first hop alone unless a redirect is
  // refused, and a followed one would carry the body to any host it named.
  it("refuses a redirect rather than following it off the address it validated", async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: null, diagnostics: [] }));
    });
    const redirector = await startServer((_request, response) => {
      response.writeHead(307, { location: `${target.url}/health` });
      response.end();
    });

    try {
      await expect(createFetchTransport(redirector.url)({ method: "GET", path: "/health" })).rejects.toThrow();
    } finally {
      await redirector.close();
      await target.close();
    }
  });
});
