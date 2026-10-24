import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { usePollNotice, type NamedPollRead } from "../api/poll-notice";
import { POLL_INTERVAL, projectQuery, projectsQuery, taskSearchQuery, tasksQuery } from "../api/queries";
import { formatClock } from "../lib/clock";

// Reached by id rather than imported: routes.tsx imports this file through the tasks screen.
const route = getRouteApi("/tasks");

type BoardPollNoticeProps = {
  /** The projects the board shows. */
  tags: readonly string[];
  /** The project of the picker, which the search reads. The board need not show it. */
  tag: string;
  board: string;
  several: boolean;
  searchText: string;
};

/**
 * Apart from the board, so a poll that changes nothing re-renders this alone.
 * Its reads fetch nothing: the board polls them.
 *
 * The search read counts only once it has a result: until then the board shows
 * the full listing, and the search's own line reports its failure.
 */
export function BoardPollNotice({ tags, tag, board, several, searchText }: BoardPollNoticeProps): ReactNode {
  const { client } = route.useRouteContext();
  const projectReads = useQueries({
    queries: tags.map((shownTag) => ({ ...projectQuery(client, shownTag), enabled: false })),
  });
  const listingReads = useQueries({
    queries: tags.map((shownTag) => ({ ...tasksQuery(client, shownTag), enabled: false })),
  });
  const searchRead = useQuery({ ...taskSearchQuery(client, tag, searchText), enabled: false });
  const reads: NamedPollRead[] = tags.flatMap((shownTag, index) => [
    { name: `${shownTag}:tasks`, read: listingReads[index]! },
    { name: `${shownTag}:project`, read: projectReads[index]! },
  ]);

  if (searchText !== "" && searchRead.dataUpdatedAt > 0) {
    reads.push({ name: "search", read: searchRead });
  }

  usePollNotice(`board-poll:${board}`, reads, {
    title: "The board is not up to date",
    line: (readAt) => (several
      ? `The last reads of one or more of these projects failed. The board shows the tasks of those projects as they were at ${formatClock(readAt)}.`
      : `The last reads of ${tag} failed. The board shows the tasks as they were at ${formatClock(readAt)}.`),
  });

  return null;
}

type ProjectListPollProps = {
  all: boolean;
  /** On the board of all projects: the projects the loader read or was refused, in board order. */
  tags: readonly string[];
  /** The tags the project list did not hold at the load. */
  missing: readonly string[];
};

/**
 * Polls the project list for the board of all projects, and for a board that
 * names tags the list did not hold. Apart from the board, so a poll re-renders
 * this alone: the read time changes on every poll.
 *
 * `tags` come from the loader, not from the polled list: a tag whose reads are
 * not in the cache yet would suspend the whole board. The read time is a
 * dependency, so each read of a list that still differs starts a load again.
 */
export function ProjectListPoll({ all, tags, missing }: ProjectListPollProps): ReactNode {
  const { client } = route.useRouteContext();
  const router = useRouter();
  const { data: { data: projects }, dataUpdatedAt } = useSuspenseQuery({
    ...projectsQuery(client),
    refetchInterval: POLL_INTERVAL,
  });
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
 * Polls the reads of the projects the daemon refused at the load, and loads
 * the board again once both reads of one of them succeed. Apart from the
 * board, so a poll re-renders this alone. The read time is a dependency, for
 * the reason it is one in `ProjectListPoll`.
 *
 * No read on mount: the load that refused them has just asked.
 */
export function RefusedProjectsPoll({ tags }: { tags: readonly string[] }): ReactNode {
  const { client } = route.useRouteContext();
  const router = useRouter();
  const poll = { refetchInterval: POLL_INTERVAL, retryOnMount: false };
  const projectReads = useQueries({ queries: tags.map((tag) => ({ ...projectQuery(client, tag), ...poll })) });
  const listingReads = useQueries({ queries: tags.map((tag) => ({ ...tasksQuery(client, tag), ...poll })) });
  const recovered = tags.some((_, index) => [projectReads[index]!, listingReads[index]!].every(({ status }) => status === "success"));
  const readAt = Math.max(...[...projectReads, ...listingReads].map(({ dataUpdatedAt }) => dataUpdatedAt));

  useEffect(() => {
    if (recovered) {
      void router.invalidate();
    }
  }, [recovered, readAt, router]);

  return null;
}
