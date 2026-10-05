import { describe, expect, it } from "vitest";
import { daemonUrl, isTokenText, parseDaemonRecord, recordTokenFor } from "@tasma/protocol";

describe("daemonUrl", () => {
  it("names the loopback address every bind uses", () => {
    expect(daemonUrl(9000)).toBe("http://127.0.0.1:9000");
  });
});

describe("isTokenText", () => {
  it("accepts visible ASCII alone", () => {
    expect(isTokenText("ab12-_.~!")).toBe(true);
  });

  it("refuses an empty value, a space, a control character and a character above ASCII", () => {
    expect(isTokenText("")).toBe(false);
    expect(isTokenText("ab 12")).toBe(false);
    expect(isTokenText("ab\r\nx: y")).toBe(false);
    expect(isTokenText("abÿ")).toBe(false);
  });
});

describe("parseDaemonRecord", () => {
  it("reads the port, the process and the token a record states", () => {
    expect(parseDaemonRecord('{"port": 9000, "pid": 4242, "token": "ab12"}'))
      .toEqual({ port: 9000, pid: 4242, token: "ab12" });
    expect(parseDaemonRecord('{"port": 0, "pid": 2147483647}')).toEqual({ port: 0, pid: 2_147_483_647 });
  });

  it("reads a record whose token is absent, not a string or not header text as a record without a token", () => {
    expect(parseDaemonRecord('{"port": 9000, "pid": 4242}')).toEqual({ port: 9000, pid: 4242 });
    expect(parseDaemonRecord('{"port": 9000, "pid": 4242, "token": 7}')).toEqual({ port: 9000, pid: 4242 });
    expect(parseDaemonRecord('{"port": 9000, "pid": 4242, "token": "a\\nb"}')).toEqual({ port: 9000, pid: 4242 });
  });

  it.each([
    ["text that is not JSON", "{"],
    ["a value that is not an object", "null"],
    ["a port that is not a number", '{"port": "9000", "pid": 4242}'],
    ["a port out of range", '{"port": 65536, "pid": 4242}'],
    ["a port that is not an integer", '{"port": 9000.5, "pid": 4242}'],
    ["a process id of zero", '{"port": 9000, "pid": 0}'],
    ["a process id above what a signal can name", '{"port": 9000, "pid": 2147483648}'],
  ])("reads %s as no record", (_case, text) => {
    expect(parseDaemonRecord(text)).toBeUndefined();
  });
});

describe("recordTokenFor", () => {
  const record = { port: 9000, pid: 4242, token: "ab12" };

  it("gives the token to the address the record names", () => {
    expect(recordTokenFor(record, "http://127.0.0.1:9000")).toBe("ab12");
  });

  it("gives no token to another port, another host and no record", () => {
    expect(recordTokenFor(record, "http://127.0.0.1:9001")).toBeUndefined();
    expect(recordTokenFor(record, "http://localhost:9000")).toBeUndefined();
    expect(recordTokenFor(record, "http://[::1]:9000")).toBeUndefined();
    expect(recordTokenFor(undefined, "http://127.0.0.1:9000")).toBeUndefined();
  });
});
