import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Config } from "@tasma/protocol";
import type { ReactNode } from "react";
import { projectQuery } from "../api/queries";
import { useDocumentTitle } from "../lib/document-title";
import { ArrowLeftIcon, WarningIcon } from "../lib/icons";
import { Diagnostics } from "./diagnostics";
import { ScreenHeading } from "./screen-heading";
import { SectionHeading } from "./section-heading";
import { Tag } from "./tag";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/projects/$project");

// A configuration value is user-authored text of no bounded length, so the chip
// breaks mid-token and grows down instead of holding a fixed height.
const VALUE_CHIP_CLASS = "inline-flex min-h-5.5 items-center rounded-control border border-line bg-surface-2 px-2 text-sm wrap-anywhere";
const CHIPS_CLASS = "flex flex-wrap gap-1.5";

function NoValue(): ReactNode {
  return <span className="text-sm text-dim">None</span>;
}

function ConfigurationRow({ term, children }: { term: string; children: ReactNode }): ReactNode {
  return (
    // The term stacks above its value below sm: a 9rem column and the gap beside
    // it are wider than a 320px viewport leaves for the row, so the values would
    // be laid out in what is left and run off the side.
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[9rem_1fr]">
      <dt className="text-sm text-muted">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * What a status is to the project, beside the status itself. The space before
 * the mark is what separates the two words in speech; a flex container drops a
 * text run of nothing but space from the layout, so the border carries the
 * separation on screen.
 *
 * The mark holds its width: it is a flex item of a chip that breaks mid-token,
 * and a shrinkable item under that rule narrows to one character and breaks its
 * own word down a column.
 */
function StatusMark({ children }: { children: string }): ReactNode {
  return (
    <>
      {" "}
      <span className="ml-1.5 shrink-0 border-l border-line pl-1.5 text-xs text-dim">{children}</span>
    </>
  );
}

/*
 * Every list of the configuration is keyed by position: the engine resolves what
 * the files declare and checks the type alone, so a hand-edited config.yml — the
 * very thing the diagnostics channel reports on — reaches this screen with the
 * same value twice.
 */
function StatusChips({ config }: { config: Config }): ReactNode {
  return (
    <span className={CHIPS_CLASS}>
      {config.statuses.map((status, index) => (
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <span key={index} className={VALUE_CHIP_CLASS}>
          {status}
          {status === config.default_status && <StatusMark>default</StatusMark>}
          {config.final_statuses.includes(status) && <StatusMark>final</StatusMark>}
        </span>
      ))}
    </span>
  );
}

function ValueChips({ values }: { values: readonly string[] }): ReactNode {
  if (values.length === 0) {
    return <NoValue />;
  }

  return (
    <span className={CHIPS_CLASS}>
      {values.map((value, index) => (
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <span key={index} className={VALUE_CHIP_CLASS}>
          {value}
        </span>
      ))}
    </span>
  );
}

function InstructionLines({ paths }: { paths: readonly string[] }): ReactNode {
  if (paths.length === 0) {
    return <NoValue />;
  }

  return paths.map((path, index) => (
    // eslint-disable-next-line @eslint-react/no-array-index-key
    <span key={index} className="block font-mono text-sm wrap-anywhere">
      {path}
    </span>
  ));
}

/**
 * What the live region says. It is a summary of the two things a refetch can
 * turn up, not the notice and the findings themselves: an announcement that
 * something interrupts is lost, and the rows carry a code, a message and a
 * location each.
 */
function stateSummary(live: boolean, findings: number): string {
  const said: string[] = [];

  if (!live) {
    said.push("The index is not following the disk.");
  }
  if (findings > 0) {
    said.push(`${String(findings)} ${findings === 1 ? "finding" : "findings"} about this project.`);
  }

  return said.join(" ");
}

/**
 * `live` is false only where a repair was attempted on this very request and did
 * not work, so the notice says the index stopped following the disk rather than
 * that anything is broken. A lost disk needs a human, which is what `signal`
 * marks.
 */
function LiveNotice(): ReactNode {
  return (
    <div role="note" className="mt-7 flex gap-3 rounded-card border border-line bg-surface px-4 py-3">
      <WarningIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-signal" />
      <div>
        <p className="font-chrome text-base font-medium text-signal">The index is not following the disk</p>
        <p className="mt-0.5 text-sm text-muted">
          The daemon could not repair the index of this project on this request. What it reports about this project
          can be older than the files on disk. Reload to try again.
        </p>
      </div>
    </div>
  );
}

export function ProjectScreen(): ReactNode {
  const { client } = route.useRouteContext();
  const { project: tag } = route.useParams();
  const { data: { data: project, diagnostics } } = useSuspenseQuery(projectQuery(client, tag));
  const { name, path, live, config } = project;
  const title = name ?? tag;

  useDocumentTitle(title);

  return (
    <div className="w-full max-w-2xl">
      {/* A link, not a heading: the page's one h1 opens the content. */}
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-text">
        <ArrowLeftIcon size={16} aria-hidden="true" />
        Projects
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <ScreenHeading>{title}</ScreenHeading>
        {/* Dropped where the heading is already the tag, so it is not shown twice. */}
        {name !== undefined && <Tag>{tag}</Tag>}
      </div>
      {path !== undefined && <p className="mt-2 font-mono text-sm text-muted wrap-anywhere">{path}</p>}

      {/*
       * The region stands whether or not it says anything: a refetch on window
       * focus can turn the notice or a finding up while the page stays put, and
       * a live region inserted together with its content announces nothing.
       */}
      <div role="status" className="sr-only">
        {stateSummary(live, diagnostics.length)}
      </div>
      {!live && <LiveNotice />}
      <Diagnostics items={diagnostics} />

      {/* The list carries no name of its own: a `dl` is exposed as a generic
          element, and ARIA prohibits naming one. The heading says what it is. */}
      <SectionHeading>Configuration</SectionHeading>
      <dl className="mt-2 divide-y divide-line rounded-card border border-line bg-surface">
        <ConfigurationRow term="Statuses">
          <StatusChips config={config} />
        </ConfigurationRow>
        <ConfigurationRow term="Priorities">
          <ValueChips values={config.priorities} />
        </ConfigurationRow>
        <ConfigurationRow term="Workflows">
          <ValueChips values={config.workflows} />
        </ConfigurationRow>
        <ConfigurationRow term="Project instructions">
          <InstructionLines paths={config.instructions} />
        </ConfigurationRow>
      </dl>
    </div>
  );
}
