const WEB_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// `URL` accepts characters such as `,` and `*` in a host, which no domain name holds.
const HOST = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/**
 * The host to save as a development domain, or `null` for text that is not a
 * domain. `URL` follows the WHATWG standard, as the `url` crate of the macOS app
 * does, so the host has the form the app compares: lowercase, IDN as punycode.
 */
export function devDomain(text: string): string | null {
  const trimmed = text.trim();
  const web = WEB_SCHEME.test(trimmed);
  if (!web && ANY_SCHEME.test(trimmed)) {
    return null;
  }

  const hostname = URL.parse(web ? trimmed : `http://${trimmed}`)?.hostname;
  if (hostname === undefined) {
    return null;
  }
  if (hostname.startsWith("[")) {
    return hostname;
  }

  const host = hostname.replace(/^\*?\./, "").replace(/\.$/, "");

  return HOST.test(host) ? host : null;
}
