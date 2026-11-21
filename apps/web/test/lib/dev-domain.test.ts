import { expect, it } from "vitest";
import { devDomain } from "../../src/lib/dev-domain";

it.each([
  ["https://Example.dev/path", "example.dev"],
  ["HTTP://Example.dev", "example.dev"],
  ["example.dev:3000/x", "example.dev"],
  ["*.example.dev", "example.dev"],
  [".example.dev", "example.dev"],
  ["example.dev.", "example.dev"],
  ["Ünï.dev", "xn--n-nga1b.dev"],
  ["localhost", "localhost"],
  ["192.168.0.10", "192.168.0.10"],
  ["[::1]", "[::1]"],
  ["http://[::1]:3000/x", "[::1]"],
  ["_service.example.dev", "_service.example.dev"],
  ["  example.dev  ", "example.dev"],
])("saves %j as %j", (text, host) => {
  expect(devDomain(text)).toBe(host);
});

it.each([
  ["my site"],
  ["https://"],
  ["ftp://example.dev"],
  ["WS://example.dev"],
  ["   "],
  ["*."],
  ["."],
  ["*"],
  ["*example.dev"],
  ["example.dev,example.test"],
  ["example..dev"],
  ["..example.dev"],
  ["example.dev.."],
])("gives no host for %j", (text) => {
  expect(devDomain(text)).toBeNull();
});
