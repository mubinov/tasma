import { APP_SCHEME } from "./paths";

/** True only when the page runs in the macOS app, on the tasma-app: origin. */
export function appAvailable(): boolean {
  return location.protocol === `${APP_SCHEME}:`;
}
