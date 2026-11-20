import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { sendLinkSettings } from "../api/link-settings";
import { useUiStore } from "../store/ui";

/** Sends the link settings to the macOS app at start and after each change. */
export function LinkSettingsSync(): null {
  const settings = useUiStore(useShallow((state) => state.linkSettings));

  useEffect(() => {
    void sendLinkSettings(settings);
  }, [settings]);

  return null;
}
