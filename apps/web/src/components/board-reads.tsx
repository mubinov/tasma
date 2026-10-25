import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { projectQuery, projectsQuery, taskSearchQuery, tasksQuery } from "../api/queries";
import { useRefusalNotice, type RefusalRead } from "../api/refusal-notice";
import { formatClock } from "../lib/clock";

// Reached by id rather than imported: routes.tsx imports this file through the tasks screen.
const route = getRouteApi("/tasks");

/**
 * For a board of one project only: on a board of several, a refused project
 * leaves the board, and its inline note gives the refusal.
 *
 * Apart from the board, so a read that changes nothing re-renders this alone.
 * Its reads fetch nothing: the board reads them.
 *
 * The search read joins only once it has a result: until then the board shows
 * the full listing, and the search's own line reports its failure.
 */
export function BoardRefusalNotice({ tag, searchText }: { tag: string; searchText: string }): ReactNode {
  const { client } = route.useRouteContext();
  const listing = tasksQuery(client, tag);
  const project = projectQuery(client, tag);
  const search = taskSearchQuery(client, tag, searchText);
  const listingRead = useQuery({ ...listing, enabled: false });
  const projectRead = useQuery({ ...project, enabled: false });
  const searchRead = useQuery({ ...search, enabled: false });
  const reads: RefusalRead[] = [
    { queryKey: listing.queryKey, result: listingRead },
    { queryKey: project.queryKey, result: projectRead },
  ];

  if (searchText !== "" && searchRead.dataUpdatedAt > 0) {
    reads.push({ queryKey: search.queryKey, result: searchRead });
  }

  useRefusalNotice(`board-refusal:${tag}`, reads, {
    title: "The board is not up to date",
    line: (refusedAt) => `The daemon refused a read of ${tag}. The board shows the tasks as they were before ${formatClock(refusedAt)}.`,
    upToDate: "The board is up to date.",
  });

  return null;
}

type ProjectListReloadProps = {
  all: boolean;
  /** On the board of all projects: the projects the loader read or was refused, in board order. */
  tags: readonly string[];
  /** The tags the project list did not hold at the load. */
  missing: readonly string[];
};

/**
 * Loads the board again when the project list no longer matches the board of
 * all projects, or now holds a tag of `missing`. Apart from the
 * board, so a read of the list re-renders this alone: the read time changes on
 * every read.
 *
 * `tags` come from the loader, not from the list this reads: a tag whose reads
 * are not in the cache yet would suspend the whole board. The read time is a
 * dependency, so each read of a list that still differs starts a load again.
 */
export function ProjectListReload({ all, tags, missing }: ProjectListReloadProps): ReactNode {
  const { client } = route.useRouteContext();
  const router = useRouter();
  const { data: { data: projects }, dataUpdatedAt } = useSuspenseQuery(projectsQuery(client));
  const listed = projects.map((project) => project.tag);
  const tagsChanged = all ? listed.join(",") !== tags.join(",") : missing.some((tag) => listed.includes(tag));

  useEffect(() => {
    if (tagsChanged) {
      void router.invalidate();
    }
  }, [tagsChanged, dataUpdatedAt, router]);

  return null;
}

/**
 * Loads the board again once both reads of a project the daemon refused at the
 * load succeed. Apart from the board, so a read re-renders this alone. The read
 * time is a dependency, for the reason it is one in `ProjectListReload`.
 *
 * Reads them again on mount: a change can come after the load read them and
 * before this mounts, and a refusal marks a query old by itself, so the mark
 * of that change cannot be told apart.
 */
export function RefusedProjectsReload({ tags }: { tags: readonly string[] }): ReactNode {
  const { client } = route.useRouteContext();
  const router = useRouter();
  const projectReads = useQueries({ queries: tags.map((tag) => projectQuery(client, tag)) });
  const listingReads = useQueries({ queries: tags.map((tag) => tasksQuery(client, tag)) });
  const recovered = tags.some((_, index) => [projectReads[index]!, listingReads[index]!].every(({ status }) => status === "success"));
  const readAt = Math.max(...[...projectReads, ...listingReads].map(({ dataUpdatedAt }) => dataUpdatedAt));

  useEffect(() => {
    if (recovered) {
      void router.invalidate();
    }
  }, [recovered, readAt, router]);

  return null;
}
