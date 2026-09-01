import { once } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DaemonError } from "../../src/http/failure.js";
import { BODY_LIMIT, readBody, writeEnvelope } from "../../src/http/json.js";

const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };

function incoming(
  method: string,
  headers: IncomingHttpHeaders,
  source: Iterable<string> | AsyncIterable<string> = [],
): IncomingMessage {
  // Not object mode: a real request carries bytes, and the byte watermark is
  // what makes an oversized body stop being pulled part way through.
  const stream = Readable.from(source, { objectMode: false }) as unknown as IncomingMessage;
  stream.method = method;
  stream.headers = headers;
  return stream;
}

/** The code a refusal carries, and the proof that it is one the daemon raised. */
async function refusalOf(pending: Promise<unknown>): Promise<string> {
  const thrown: unknown = await pending.then(() => undefined, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(DaemonError);
  return (thrown as DaemonError).code;
}

type Reply = { status: number; headers: OutgoingHttpHeaders; body: string };

function collector(): { reply: Reply; response: ServerResponse } {
  const reply: Reply = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status: number, headers: OutgoingHttpHeaders) {
      reply.status = status;
      reply.headers = headers;
      return response;
    },
    end(chunk: Buffer) {
      reply.body = chunk.toString("utf8");
    },
  };

  return { reply, response: response as unknown as ServerResponse };
}

describe("reading a body", () => {
  it("reads the JSON a POST carries", async () => {
    const request = incoming("POST", JSON_TYPE, ['{"title":"Write it"}']);

    await expect(readBody(request)).resolves.toEqual({ title: "Write it" });
  });

  it("accepts a content type that carries a charset", async () => {
    const request = incoming("PATCH", { "content-type": "Application/JSON ; charset=utf-8" }, ["{}"]);

    await expect(readBody(request)).resolves.toEqual({});
  });

  it("refuses a POST that declares another content type", async () => {
    const request = incoming("POST", { "content-type": "text/plain" }, ["{}"]);

    await expect(refusalOf(readBody(request))).resolves.toBe("unsupported-media-type");
  });

  it("refuses a POST that declares no content type at all", async () => {
    const request = incoming("POST", {}, ["{}"]);

    await expect(refusalOf(readBody(request))).resolves.toBe("unsupported-media-type");
  });

  it("reads no body for a GET, and drains the request", async () => {
    const request = incoming("GET", {}, ["ignored"]);
    const ended = once(request, "end");

    await expect(readBody(request)).resolves.toBeUndefined();
    await ended;
  });

  it("reads no body for a DELETE", async () => {
    const request = incoming("DELETE", {}, []);

    await expect(readBody(request)).resolves.toBeUndefined();
  });

  it("reads an empty body as no body rather than refusing it", async () => {
    const request = incoming("POST", { ...JSON_TYPE, "content-length": "0" }, []);

    await expect(readBody(request)).resolves.toBeUndefined();
  });

  it("refuses a body that is not JSON", async () => {
    const request = incoming("POST", JSON_TYPE, ["{"]);

    await expect(refusalOf(readBody(request))).resolves.toBe("malformed-request");
  });

  it("refuses a declared length over the cap before a byte is read", async () => {
    let pulled = false;
    async function* body() {
      pulled = true;
      yield "{}";
    }
    const request = incoming("POST", { ...JSON_TYPE, "content-length": `${BODY_LIMIT + 1}` }, body());

    await expect(refusalOf(readBody(request))).resolves.toBe("request-too-large");
    expect(pulled).toBe(false);
  });

  it("reads a declared length at the cap", async () => {
    const request = incoming("POST", { ...JSON_TYPE, "content-length": `${BODY_LIMIT}` }, ["{}"]);

    await expect(readBody(request)).resolves.toEqual({});
  });

  it("ignores a declared length that is not a number, and reads the body", async () => {
    const request = incoming("POST", { ...JSON_TYPE, "content-length": "some" }, ["{}"]);

    await expect(readBody(request)).resolves.toEqual({});
  });

  it("refuses a chunked body over the cap mid-stream, and stops reading it", async () => {
    const megabyte = "x".repeat(1024 * 1024);
    let sent = 0;
    async function* body() {
      for (let index = 0; index < 16; index++) {
        sent++;
        yield megabyte;
      }
    }
    const request = incoming("POST", JSON_TYPE, body());

    await expect(refusalOf(readBody(request))).resolves.toBe("request-too-large");
    expect(sent).toBeLessThan(16);
    // Reading stops, and the request stays alive: the refusal is still to be
    // written on the connection carrying it.
    expect(request.isPaused()).toBe(true);
    expect(request.destroyed).toBe(false);
  });
});

describe("writing an envelope", () => {
  it("sends the JSON headers, the computed length and no-store", () => {
    const { reply, response } = collector();

    writeEnvelope(response, 200, { ok: true, data: { name: "tasma-daemon" }, diagnostics: [] });

    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"ok":true,"data":{"name":"tasma-daemon"},"diagnostics":[]}');
    expect(reply.headers).toEqual({
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(reply.body),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  });

  it("measures the length in bytes rather than in characters", () => {
    const { reply, response } = collector();

    writeEnvelope(response, 200, { ok: true, data: "ä", diagnostics: [] });

    expect(reply.headers["content-length"]).toBe(Buffer.byteLength(reply.body));
    expect(reply.headers["content-length"]).toBeGreaterThan(reply.body.length);
  });

  it("names the allowed methods only where the caller passes them", () => {
    const { reply, response } = collector();

    writeEnvelope(
      response,
      405,
      { ok: false, error: { kind: "daemon", code: "method-not-allowed", message: "no" } },
      ["GET", "POST"],
    );

    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("GET, POST");
  });
});
