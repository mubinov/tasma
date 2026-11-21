import { useId, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { normalizeUri } from "micromark-util-sanitize-uri";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { appAvailable } from "../api/app";
import { fileUrl, openFileLink } from "../lib/file-link";
import { WarningIcon } from "../lib/icons";
import { linkKind } from "../lib/link-kind";
import {
  hiddenHost,
  markdownUrl,
  mermaidSource,
  rehypeFileLinks,
  rehypeLinkText,
  remarkImagesAsLinks,
  remarkRawAsSource,
  remarkSoftBreaks,
  remarkTaskHeadings,
  showsUrl,
  type TaskHeadingsOptions,
} from "../lib/markdown";
import { reopenNotice } from "../store/notices";
import { LinkContextMenu, TaskLink, type MenuTarget } from "./link-menu";
import { MermaidDiagram } from "./mermaid-diagram";
import { Tooltip } from "./tooltip";

type MarkdownProps = TaskHeadingsOptions & {
  text: string;
  /** Draws the Mermaid blocks. False shows their source, for a text that has no layout yet. */
  diagrams?: boolean;
  /** The folder that a relative file link resolves against. */
  folder?: string | undefined;
};

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
    : "mt-5 font-chrome text-base font-medium text-subtle";
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

type FileTarget = { path: string; line: number | undefined };

/**
 * Opens the file through the app, with no navigation. `onClick` is the handler of the tooltip and the menu trigger;
 * a click it prevents opens nothing.
 */
function FileLink({ file, onClick, ...props }: ComponentProps<"a"> & { file: FileTarget }): ReactNode {
  return (
    <a
      {...props}
      href={fileUrl(file.path)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        void openFileLink(file.path, file.line, reopenNotice);
      }}
    />
  );
}

/** What the tooltip and the description show: the href, or for a file link its absolute path. */
function linkTarget(href: string, file: FileTarget | undefined): { shown: string; described: string } {
  if (file === undefined) {
    return { shown: href, described: href };
  }
  if (file.line === undefined) {
    return { shown: file.path, described: file.path };
  }
  // The description names the line in words, so a screen reader does not read "number sign L".
  return { shown: `${file.path}#L${String(file.line)}`, described: `${file.path}, line ${String(file.line)}` };
}

export function MarkdownLink(
  { node, href, children }: ChildrenProps & ExtraProps & { href?: string | undefined },
): ReactNode {
  const descriptionId = useId();
  // A footnote back-reference is a `#…` link: with its href dropped, only a "↩" that does nothing is left.
  if (node?.properties.dataFootnoteBackref !== undefined) {
    return null;
  }
  const link = href === undefined ? undefined : linkKind(href);
  // A link whose URL markdownUrl drops arrives with no href. markdownUrl keeps only an href with a kind.
  if (href === undefined || link === undefined) {
    return children;
  }
  let target: MenuTarget;
  if (link.kind === "file") {
    // rehypeFileLinks sets no path when the text has no folder for a relative link.
    const path = node?.properties.dataPath;
    if (typeof path !== "string" || !appAvailable()) {
      return children;
    }
    target = { kind: "file", path, line: link.line };
  } else if (link.kind === "task") {
    target = { kind: "task", href, id: link.id };
  } else {
    target = { kind: link.kind, href };
  }
  const file = target.kind === "file" ? target : undefined;
  const { shown, described } = linkTarget(href, file);
  const named = node?.children.some(hasText) === true;
  const text = String(node?.properties.dataText);
  const label = named ? text : href;
  // The target that the text of the link hides. A text that shows a URL or a domain hides that a file link opens a
  // file.
  let hidden: string | undefined;
  if (file !== undefined) {
    hidden = showsUrl(label) ? file.path : undefined;
  } else if (named && target.kind === "web") {
    hidden = hiddenHost(text, href);
  }
  // A link named by its own URL gets no description, so a screen reader does not read the URL twice. The href is
  // the output of normalizeUri and then markdownUrl, so the text goes through both. A GFM `www.` literal gets
  // `http://`, and an email autolink gets `mailto:`. The href of a file link can be relative, so the text it shows
  // is compared with its absolute target.
  const describe = file === undefined
    ? named && ["", "http://", "mailto:"].every((prefix) => markdownUrl(normalizeUri(prefix + text)) !== href)
    : label !== described;
  const linkProps = {
    "dir": "ltr",
    "aria-describedby": describe ? descriptionId : undefined,
    "className": "underline underline-offset-2",
  };
  const content = (
    <>
      {named ? children : href}
      {hidden !== undefined && <span className="sr-only">{` (warning: goes to ${hidden})`}</span>}
    </>
  );
  let anchor: ReactElement;
  if (target.kind === "task") {
    anchor = <TaskLink {...linkProps} task={target.id}>{content}</TaskLink>;
  } else if (target.kind === "file") {
    anchor = <FileLink {...linkProps} file={target}>{content}</FileLink>;
  } else {
    anchor = <a {...linkProps} href={href} target="_blank" rel="noreferrer">{content}</a>;
  }
  return (
    // The isolates keep a bidi control in the text around the link, or in the link text, from reordering the link
    // and its mark. `dir` on the `<a>` gives it `unicode-bidi: isolate`. They hold because rehypeLinkText removes
    // every PDI from the link text.
    <bdi dir="ltr">
      <Tooltip content={<span className="font-mono">{shown}</span>}>
        <LinkContextMenu target={target}>{anchor}</LinkContextMenu>
      </Tooltip>
      {/* A hidden element still gives the description, and the virtual cursor does not read it as text. */}
      {describe && <span id={descriptionId} hidden>{described}</span>}
      {hidden !== undefined && (
        <span aria-hidden="true" className="ml-1.5 text-signal wrap-anywhere">
          (
          <WarningIcon size="1em" className="mr-0.5 inline align-[-0.125em]" />
          {hidden}
          )
        </span>
      )}
    </bdi>
  );
}

function CodeBlock({ node, children, diagrams }: ChildrenProps & ExtraProps & { diagrams: boolean }): ReactNode {
  const source = mermaidSource(node);
  if (source !== null) {
    return <MermaidDiagram source={source} draw={diagrams} />;
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
  blockquote: ({ children }) => <blockquote className="mt-2.5 border-l-2 border-line pl-3 text-subtle">{children}</blockquote>,
  hr: () => <hr className="mt-5 border-line" />,
  code: ({ children }) => (
    <code className="rounded-[4px] bg-surface-2 px-[5px] py-px font-mono text-xs-plus">{children}</code>
  ),
  pre: (props) => <CodeBlock {...props} diagrams />,
  table: ({ children }) => (
    // A tab stop for the same reason as `pre`.
    <div tabIndex={0} className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  // Cells do not inherit `wrap-anywhere`: it lowers the min-content width of a cell to one character, so the table
  // squeezes its short columns in place of scrolling.
  th: ({ node, children }) => (
    <th className={`border-b border-line py-2 pr-3 ${cellAlignClass(node)} align-top text-xs-plus font-medium text-subtle wrap-normal`}>
      {children}
    </th>
  ),
  td: ({ node, children }) => (
    <td className={`border-b border-line py-2 pr-3 ${cellAlignClass(node)} align-top wrap-normal`}>{children}</td>
  ),
  strong: ({ children }) => <strong className="font-medium">{children}</strong>,
  a: MarkdownLink,
};

// Kept at module level: a map built on each render gives each renderer a new identity, which remounts the whole text.
const sourceComponents: Components = { ...components, pre: (props) => <CodeBlock {...props} diagrams={false} /> };

/**
 * Renders the markdown of a task body or a comment body: GitHub-flavoured, raw
 * HTML shown as source, a single newline shown as a line break, task links
 * opened in the app, file links opened through the app and other links outside
 * it, no image loaded, Mermaid blocks drawn as diagrams.
 */
export function Markdown({ text, base, title, diagrams = true, folder }: MarkdownProps): ReactNode {
  return (
    <div className="wrap-anywhere [&>:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkRawAsSource,
          [remarkTaskHeadings, { base, title }],
          remarkImagesAsLinks,
          remarkSoftBreaks,
        ]}
        // The footnote label is added after the remark plugins run, so no heading rank reaches it.
        rehypePlugins={[rehypeLinkText, [rehypeFileLinks, { folder }]]}
        remarkRehypeOptions={{ footnoteLabelTagName: "p" }}
        urlTransform={markdownUrl}
        components={diagrams ? components : sourceComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
