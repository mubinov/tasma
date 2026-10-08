import { useId, type ReactNode } from "react";
import { normalizeUri } from "micromark-util-sanitize-uri";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { WarningIcon } from "../lib/icons";
import {
  hiddenHost,
  markdownUrl,
  mermaidSource,
  rehypeLinkText,
  remarkImagesAsLinks,
  remarkRawAsSource,
  remarkTaskHeadings,
  type TaskHeadingsOptions,
} from "../lib/markdown";
import { MermaidDiagram } from "./mermaid-diagram";
import { Tooltip } from "./tooltip";

type MarkdownProps = TaskHeadingsOptions & { text: string };

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

type ChildrenProps = { children?: ReactNode };

const CELL_ALIGN_CLASSES: Partial<Record<string, string>> = { center: "text-center", right: "text-right" };

type HastNode = NonNullable<ExtraProps["node"]>["children"][number];

function headingClass(depth: number): string {
  if (depth <= 2) {
    return "mt-7 font-chrome text-lg font-semibold";
  }
  return depth === 3
    ? "mt-6 font-chrome text-base font-semibold"
    : "mt-5 font-chrome text-base font-medium text-muted";
}

function cellAlignClass(node: ExtraProps["node"]): string {
  return CELL_ALIGN_CLASSES[String(node?.properties.align)] ?? "text-left";
}

function hasText(node: HastNode): boolean {
  return node.type === "text" ? node.value.trim() !== "" : node.type === "element" && node.children.some(hasText);
}

function MarkdownHeading({ node, children }: ChildrenProps & ExtraProps): ReactNode {
  const Tag = node?.tagName as HeadingTag;
  const depth = Number(node?.properties.dataLevel);
  return <Tag data-level={depth} className={headingClass(depth)}>{children}</Tag>;
}

function MarkdownLink({ node, href, children }: ChildrenProps & ExtraProps & { href?: string | undefined }): ReactNode {
  const descriptionId = useId();
  // A footnote back-reference is a `#…` link: with its href dropped, only a "↩" that does nothing is left.
  if (node?.properties.dataFootnoteBackref !== undefined) {
    return null;
  }
  // A link whose URL markdownUrl drops arrives with no href.
  if (href === undefined) {
    return children;
  }
  const named = node?.children.some(hasText) === true;
  const text = String(node?.properties.dataText);
  const host = named ? hiddenHost(text, href) : undefined;
  // A link named by its own URL gets no description, so a screen reader does not read the URL twice. The href is
  // the output of normalizeUri and then markdownUrl, so the text goes through both. A GFM `www.` literal gets
  // `http://`, and an email autolink gets `mailto:`.
  const describe = named && ["", "http://", "mailto:"].every((prefix) => markdownUrl(normalizeUri(prefix + text)) !== href);
  return (
    // The isolates keep a bidi control in the text around the link, or in the link text, from reordering the link
    // and its mark. `dir` on the `<a>` gives it `unicode-bidi: isolate`. They hold because rehypeLinkText removes
    // every PDI from the link text.
    <bdi dir="ltr">
      <Tooltip content={<span className="font-mono">{href}</span>}>
        <a
          dir="ltr"
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-describedby={describe ? descriptionId : undefined}
          className="underline underline-offset-2"
        >
          {named ? children : href}
          {host !== undefined && <span className="sr-only">{` (warning: goes to ${host})`}</span>}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Tooltip>
      {/* A hidden element still gives the description, and the virtual cursor does not read it as text. */}
      {describe && <span id={descriptionId} hidden>{href}</span>}
      {host !== undefined && (
        <span aria-hidden="true" className="ml-1.5 text-signal wrap-anywhere">
          (
          <WarningIcon size="1em" className="mr-0.5 inline align-[-0.125em]" />
          {host}
          )
        </span>
      )}
    </bdi>
  );
}

const components: Components = {
  h1: MarkdownHeading,
  h2: MarkdownHeading,
  h3: MarkdownHeading,
  h4: MarkdownHeading,
  h5: MarkdownHeading,
  h6: MarkdownHeading,
  // The GFM footnote label is a `p` with `sr-only`, so its class is kept.
  p: ({ className, children }) => <p className={className ?? "mt-2.5"}>{children}</p>,
  ul: ({ children }) => <ul className="mt-2.5 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2.5 list-decimal pl-5">{children}</ol>,
  li: ({ className, children }) => (
    <li className={className === "task-list-item" ? "mt-1 list-none" : "mt-1"}>{children}</li>
  ),
  // The box is a read-only mark: the screen reader gets its state as text.
  input: ({ type, checked }) => (
    <>
      <input type={type} checked={checked} disabled aria-hidden className="mr-1.5" />
      <span className="sr-only">{checked === true ? "Done:" : "Not done:"}</span>
    </>
  ),
  blockquote: ({ children }) => <blockquote className="mt-2.5 border-l-2 border-line pl-3 text-muted">{children}</blockquote>,
  hr: () => <hr className="mt-5 border-line" />,
  code: ({ children }) => (
    <code className="rounded-[4px] bg-surface-2 px-[5px] py-px font-mono text-xs-plus">{children}</code>
  ),
  pre: ({ node, children }) => {
    const source = mermaidSource(node);
    if (source !== null) {
      return <MermaidDiagram source={source} />;
    }
    return (
      // A scroll container with nothing focusable inside is a tab stop only in some engines.
      <pre
        tabIndex={0}
        className="mt-3 overflow-x-auto rounded-card bg-surface-2 px-3.5 py-3 font-mono text-xs-plus [&>code]:bg-transparent [&>code]:p-0"
      >
        {children}
      </pre>
    );
  },
  table: ({ children }) => (
    // A tab stop for the same reason as `pre`.
    <div tabIndex={0} className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  // Cells do not inherit `wrap-anywhere`: it lowers the min-content width of a cell to one character, so the table
  // squeezes its short columns in place of scrolling.
  th: ({ node, children }) => (
    <th className={`border-b border-line py-2 pr-3 ${cellAlignClass(node)} align-top text-xs-plus font-medium text-muted wrap-normal`}>
      {children}
    </th>
  ),
  td: ({ node, children }) => (
    <td className={`border-b border-line py-2 pr-3 ${cellAlignClass(node)} align-top wrap-normal`}>{children}</td>
  ),
  strong: ({ children }) => <strong className="font-medium">{children}</strong>,
  a: MarkdownLink,
};

/**
 * Renders the markdown of a task body or a comment body: GitHub-flavoured, raw
 * HTML shown as source, links opened in a new tab, no image loaded, Mermaid
 * blocks drawn as diagrams.
 */
export function Markdown({ text, base, title }: MarkdownProps): ReactNode {
  return (
    <div className="wrap-anywhere [&>:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkRawAsSource,
          [remarkTaskHeadings, { base, title }],
          remarkImagesAsLinks,
        ]}
        // The footnote label is added after the remark plugins run, so no heading rank reaches it.
        rehypePlugins={[rehypeLinkText]}
        remarkRehypeOptions={{ footnoteLabelTagName: "p" }}
        urlTransform={markdownUrl}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
