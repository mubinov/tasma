import type { ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  markdownUrl,
  remarkImagesAsLinks,
  remarkRawAsSource,
  remarkTaskHeadings,
  type TaskHeadingsOptions,
} from "../lib/markdown";

type MarkdownProps = TaskHeadingsOptions & { text: string };

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

type ChildrenProps = { children?: ReactNode };

const CELL_ALIGN_CLASSES: Partial<Record<string, string>> = { center: "text-center", right: "text-right" };

type HastNode = NonNullable<ExtraProps["node"]>["children"][number];

function headingClass(depth: number): string {
  if (depth <= 2) {
    return "mt-7 font-chrome text-lg font-semibold tracking-tight";
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
  // A footnote back-reference is a `#…` link: with its href dropped, only a "↩" that does nothing is left.
  if (node?.properties.dataFootnoteBackref !== undefined) {
    return null;
  }
  // A link whose URL markdownUrl drops arrives with no href.
  if (href === undefined) {
    return children;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {node?.children.some(hasText) ? children : href}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
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
  pre: ({ children }) => (
    // A scroll container with nothing focusable inside is a tab stop only in some engines.
    <pre
      tabIndex={0}
      className="mt-3 overflow-x-auto rounded-card bg-surface-2 px-3.5 py-3 font-mono text-xs-plus [&>code]:bg-transparent [&>code]:p-0"
    >
      {children}
    </pre>
  ),
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
 * HTML shown as source, links opened in a new tab, no image loaded.
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
        remarkRehypeOptions={{ footnoteLabelTagName: "p" }}
        urlTransform={markdownUrl}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
