import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { ProjectSummary } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { projectsQuery } from "../api/queries";
import { useDocumentTitle } from "../lib/document-title";
import { CaretRightIcon } from "../lib/icons";
import { NAVIGATION_BY_PATH } from "../navigation";
import { Diagnostics } from "./diagnostics";
import { ScreenHeading } from "./screen-heading";
import { Tag } from "./tag";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/projects/");

function ProjectRow({ tag, name, path }: ProjectSummary): ReactNode {
  return (
    <Link
      to="/projects/$project"
      params={{ project: tag }}
      className="flex items-start gap-4 rounded-card border border-line bg-surface px-4 py-3 hover:border-graphic"
    >
      <span className="min-w-0 flex-1">
        {/* A row with no name keeps the height of one that has it, so the rows
            of a list line up either way. */}
        <span className="flex min-h-5.5 flex-wrap items-center gap-2">
          {name !== undefined && <span className="font-chrome text-base font-medium">{name}</span>}
          <Tag>{tag}</Tag>
        </span>
        {path !== undefined && <span className="mt-0.5 block font-mono text-xs text-dim wrap-anywhere">{path}</span>}
      </span>
      <CaretRightIcon size={16} aria-hidden="true" className="mt-0.75 shrink-0 text-dim" />
    </Link>
  );
}

export function ProjectsScreen(): ReactNode {
  const { label: title } = NAVIGATION_BY_PATH["/projects"];
  const { client } = route.useRouteContext();
  // The loader filled the cache before this mounted, so the first render holds
  // the answer rather than suspending.
  const { data: { data: projects, diagnostics } } = useSuspenseQuery(projectsQuery(client));
  const headingId = useId();

  useDocumentTitle(title);

  return (
    <>
      <ScreenHeading id={headingId}>{title}</ScreenHeading>
      <Diagnostics items={diagnostics} />
      {projects.length === 0
        ? (
            <p className="mt-2 text-base text-muted">
              No projects yet. The daemon&apos;s tree holds no project directory. Add one, and it is listed here.
            </p>
          )
        : (
            // A plain list rather than VirtualList: one row per project
            // directory of the tree the daemon watches, a count that stays a
            // person's repositories and never reaches the rows virtualising
            // pays for.
            <ul aria-labelledby={headingId} className="mt-7 flex w-full max-w-2xl flex-col gap-3">
              {projects.map((project) => (
                <li key={project.tag}>
                  <ProjectRow {...project} />
                </li>
              ))}
            </ul>
          )}
    </>
  );
}
