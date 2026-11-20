import type { LinkSettings } from "../lib/link-settings";
import { APP_PATH_PREFIX, LINKS_ROUTE } from "./paths";

let lastSend: Promise<void> = Promise.resolve();

/**
 * Each send starts after the previous one settles, so the app ends on the last
 * settings. Every failure leaves the app on the last settings it got.
 */
export function sendLinkSettings(settings: LinkSettings): Promise<void> {
  lastSend = lastSend.then(() =>
    fetch(`${APP_PATH_PREFIX}${LINKS_ROUTE}`, { method: "POST", body: JSON.stringify(settings) }).then(
      () => undefined,
      () => undefined,
    ),
  );

  return lastSend;
}
