import { useAuiState } from "@assistant-ui/react";

/** The folder of the chat of the message that renders the caller. */
export function useChatFolder(): string | undefined {
  return useAuiState((s) => {
    const { folder } = s.message.metadata.custom;
    return typeof folder === "string" ? folder : undefined;
  });
}
