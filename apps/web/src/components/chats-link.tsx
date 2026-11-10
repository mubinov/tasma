import { Link } from "@tanstack/react-router";
import { useRef, type ReactNode } from "react";
import { opensHere } from "../lib/board";
import { ArrowLeftIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";

/** Back to the list of the chats, in a window too narrow to show the list beside a chat. */
export function ChatsLink({ onBack, onFocusLost }: { onBack: () => void; onFocusLost: () => void }): ReactNode {
  const ref = useRef<HTMLAnchorElement>(null);

  useFocusLost(ref, onFocusLost);

  return (
    <Link
      ref={ref}
      from="/"
      to="/"
      search={(previous) => ({ ...previous, task: undefined, tag: undefined, chat: undefined, new: undefined })}
      // A partial match is active on every address of the dashboard.
      activeOptions={{ exact: true }}
      replace
      resetScroll={false}
      onClick={(event) => {
        if (opensHere(event)) {
          onBack();
        }
      }}
      className="mb-2 inline-flex items-center gap-1.5 text-sm text-dim hover:text-text"
    >
      <ArrowLeftIcon size={16} aria-hidden="true" />
      Chats
    </Link>
  );
}
