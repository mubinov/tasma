import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { lazy, Suspense, useState, type ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";
import { shikiClient } from "../lib/shiki-client";
import type { Hast } from "../lib/shiki-tokenize";

// The coloured block is built on the main thread, at a cost that grows with the code.
const MAX_CODE_LENGTH = 10_000;

function MarkdownCode({ components: { Pre, Code }, code }: SyntaxHighlighterProps): ReactNode {
  return (
    <Pre>
      <Code>{code}</Code>
    </Pre>
  );
}

function plainHast(code: string): Hast {
  return {
    type: "root",
    children: [{
      type: "element",
      tagName: "pre",
      properties: {},
      children: [{ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: code }] }],
    }],
  };
}

const LazyHighlighter = lazy(async () => {
  try {
    const { SyntaxHighlighter } = await import("@kit/components/assistant-ui/elements/shiki-highlighter.aui");
    return {
      default: function ChatHighlighter(props: SyntaxHighlighterProps): ReactNode {
        const [result, setResult] = useState<{ code: string; hast: Hast }>();
        // react-shiki asks a highlighter that it is given for these two members only. The kit
        // asks for the HAST only when the code is final, so that is when the worker gets it.
        const highlighter: Pick<HighlighterCore, "getLoadedLanguages" | "codeToHast"> = {
          getLoadedLanguages: () => [],
          codeToHast: (code) => {
            if (result?.code === code) return result.hast;
            void shikiClient.highlight(code, props.language).then((hast) => {
              if (hast) setResult({ code, hast });
            });
            return plainHast(code);
          },
        };
        return <SyntaxHighlighter {...props} highlighter={highlighter as HighlighterCore} />;
      },
    };
  } catch {
    return { default: MarkdownCode };
  }
});

/**
 * A fenced block of a chat message. It is plain until the worker gives it
 * colours, and it stays plain if it is too large or if Shiki fails.
 */
export function ChatCode(props: SyntaxHighlighterProps): ReactNode {
  if (props.code.length > MAX_CODE_LENGTH) {
    return <MarkdownCode {...props} />;
  }
  return (
    <Suspense fallback={<MarkdownCode {...props} />}>
      <LazyHighlighter {...props} />
    </Suspense>
  );
}
