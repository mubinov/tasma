import type { TextMessagePartComponent } from "@assistant-ui/react";

// A WebKit copy puts a line end that only `white-space: pre-line` shows into the plain text as a space;
// a `<br>` stays a line break.
export const ChatUserText: TextMessagePartComponent = ({ text }) => (
  <p>
    {text.split("\n").flatMap((line, index) =>
      // eslint-disable-next-line @eslint-react/no-array-index-key
      index === 0 ? [line] : [<br key={index} />, line],
    )}
  </p>
);
