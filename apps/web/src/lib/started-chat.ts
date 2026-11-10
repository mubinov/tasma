import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";

/** Says the words of the started chat, when no other place said them. */
export function sayStartedWords(): void {
  const words = useUiStore.getState().takeStartedWords();

  if (words !== null) {
    useNoticeStore.getState().announce(words);
  }
}
