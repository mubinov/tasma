import { useQueries, useSuspenseQueries, type QueryClient } from "@tanstack/react-query";
import type { Client, Project, Success, TaskList } from "@tasma/protocol";
import { useEffect, useRef } from "react";
import { projectQuery, tasksQuery } from "../api/queries";
import { isRefused } from "../api/refusal-notice";
import { useNoticeStore } from "../store/notices";
import { boardOrder } from "./board";

/** A project the loader read, with its two reads. */
export type LoadedProject = { tag: string; project: Success<Project>; listing: Success<TaskList> };

/** A project of the board that it does not show. `missing`: the daemon's project list does not hold the tag. */
export type FailedProject = { tag: string; missing: boolean };

export type BoardProjectsInput = {
  /** The projects the loader read, in board order. */
  tags: readonly string[];
  /** The projects whose reads the daemon refused at the load, in board order. */
  refused: readonly string[];
  /** The tags the daemon's project list did not hold at the load, in board order. */
  missing: readonly string[];
  several: boolean;
};

export type BoardProjects = {
  /** Every project the loader read, in board order. */
  loaded: readonly LoadedProject[];
  /** The loaded projects the board shows, in board order. */
  shown: readonly LoadedProject[];
  /** The projects the board names and does not show, in board order. */
  failed: readonly FailedProject[];
};

/**
 * Reads the projects the loader read, and splits the projects of the board
 * into those it shows and those it does not. On a board of several projects, a
 * loaded project whose last read the daemon refused is not shown.
 */
export function useBoardProjects(
  client: Client,
  queryClient: QueryClient,
  { tags, refused, missing, several }: BoardProjectsInput,
): BoardProjects {
  const projectReads = useSuspenseQueries({ queries: tags.map((tag) => projectQuery(client, tag)) });
  const listingReads = useSuspenseQueries({ queries: tags.map((tag) => tasksQuery(client, tag)) });
  // Combined, so a read that leaves the list as it was does not render the board again.
  const failing = useQueries({
    queries: tags.flatMap((tag) => [
      { ...projectQuery(client, tag), enabled: false },
      { ...tasksQuery(client, tag), enabled: false },
    ]),
    combine: (reads) => (several
      ? tags.filter((_, index) => isRefused(reads[2 * index]!) || isRefused(reads[2 * index + 1]!))
      : []),
  });
  const loaded = tags.map((tag, index) => ({
    tag,
    project: projectReads[index]!.data,
    listing: listingReads[index]!.data,
  }));
  const shown = loaded.filter(({ tag }) => !failing.includes(tag));
  const failed = boardOrder(refused, missing, failing).map((tag) => ({ tag, missing: missing.includes(tag) }));
  const failedRef = useRef(failed);

  // A live region does not speak a sentence that leaves it, so a project that
  // the board shows again is said on its own. One that is shown again while a
  // read still fails is not: its cards are old.
  useEffect(() => {
    const before = failedRef.current;
    failedRef.current = failed;

    for (const { tag } of before) {
      const recovered = [projectQuery(client, tag), tasksQuery(client, tag)]
        .every(({ queryKey }) => queryClient.getQueryState(queryKey)?.status === "success");

      if (recovered && shown.some((project) => project.tag === tag)) {
        useNoticeStore.getState().announce(`${tag} loaded.`);
      }
    }
  });

  return { loaded, shown, failed };
}
