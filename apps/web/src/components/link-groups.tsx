import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { browsersQuery, editorsQuery } from "../api/queries";
import type { LinkSettings } from "../lib/link-settings";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { AppSelect, type AppListState } from "./app-select";
import { DomainChips } from "./domain-chips";
import { RetryButton } from "./retry-button";

function writeLinks(change: Partial<LinkSettings>): void {
  const { linkSettings, setLinkSettings } = useUiStore.getState();
  setLinkSettings({ ...linkSettings, ...change });
}

type AppList<T> = {
  apps: T[] | undefined;
  state: AppListState;
  /** Set while the group shows its failure line. */
  failureId: string | undefined;
  refetch: () => Promise<{ isError: boolean }>;
};

/**
 * A refetch with no data clears the error of the query, so the failure line
 * keys on `errorUpdateCount`: it stays while a Retry runs, until data arrives.
 * The cache keeps the count after Settings closes, so only the failures since
 * the mount count.
 */
function useAppList<T>(query: UseQueryResult<T[]>): AppList<T> {
  const failureId = useId();
  const [errorBase] = useState(query.errorUpdateCount);
  const failed = query.data === undefined && query.errorUpdateCount > errorBase;
  const state: AppListState = query.data !== undefined ? "ready" : failed && !query.isFetching ? "failed" : "loading";

  return { apps: query.data, state, failureId: failed ? failureId : undefined, refetch: query.refetch };
}

type LinkGroupProps = {
  title: string;
  list: "browser" | "editor";
  failureId: string | undefined;
  refetch: () => Promise<{ isError: boolean }>;
  /** The first dropdown, which takes focus when a Retry succeeds. */
  firstRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
};

function LinkGroup({ title, list, failureId, refetch, firstRef, children }: LinkGroupProps): ReactNode {
  const titleId = useId();
  const line = `The ${list} list did not load.`;
  const failed = failureId !== undefined;

  // The first failure since the mount. A failed Retry speaks in `onRetry`; a failed background refetch is silent.
  useEffect(() => {
    if (failed) {
      useNoticeStore.getState().announce(line);
    }
  }, [failed, line]);

  return (
    <div role="group" aria-labelledby={titleId} className="mt-6 w-full max-w-2xl">
      <span id={titleId} className="block font-chrome text-sm font-medium">
        {title}
      </span>
      {failed && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p id={failureId} className="text-sm text-signal">
            {line}
          </p>
          <RetryButton
            label={(
              <>
                Retry
                {/* The space separates the words in speech; flex drops it from the layout. */}
                {" "}
                <span className="sr-only">{`the ${list} list`}</span>
              </>
            )}
            describedBy={failureId}
            onRetry={() => {
              void refetch().then(({ isError }) => {
                if (isError) {
                  useNoticeStore.getState().announce(line);
                }
              });
            }}
            onFocusLost={() => {
              firstRef.current?.focus();
            }}
          />
        </div>
      )}
      <div className="mt-3 flex flex-col gap-5">{children}</div>
    </div>
  );
}

export function WebLinksGroup(): ReactNode {
  const { apps, state, failureId, refetch } = useAppList(useQuery(browsersQuery()));
  const { browser, devBrowser, devDomains } = useUiStore(useShallow((store) => store.linkSettings));
  const firstRef = useRef<HTMLButtonElement>(null);
  const defaultName = apps?.find((entry) => entry.default)?.name;

  return (
    <LinkGroup title="Web links" list="browser" failureId={failureId} refetch={refetch} firstRef={firstRef}>
      <AppSelect
        ref={firstRef}
        label="Default browser"
        emptyLabel={defaultName === undefined ? "macOS default" : `macOS default (${defaultName})`}
        apps={apps}
        state={state}
        failureId={failureId}
        value={browser}
        onChange={(id) => {
          writeLinks({ browser: id });
        }}
      />
      <AppSelect
        label="Development browser"
        emptyLabel="Same as default browser"
        hint="Opens development links: localhost, IP addresses and the development domains."
        apps={apps}
        state={state}
        failureId={failureId}
        value={devBrowser}
        onChange={(id) => {
          writeLinks({ devBrowser: id });
        }}
      />
      <DomainChips
        domains={devDomains}
        onChange={(domains) => {
          writeLinks({ devDomains: domains });
        }}
      />
    </LinkGroup>
  );
}

export function FileLinksGroup(): ReactNode {
  const { apps, state, failureId, refetch } = useAppList(useQuery(editorsQuery()));
  const fileApp = useUiStore((store) => store.linkSettings.fileApp);
  const firstRef = useRef<HTMLButtonElement>(null);

  return (
    <LinkGroup title="File links" list="editor" failureId={failureId} refetch={refetch} firstRef={firstRef}>
      <AppSelect
        ref={firstRef}
        label="Open files in"
        emptyLabel="macOS default app"
        apps={apps}
        state={state}
        failureId={failureId}
        value={fileApp}
        onChange={(id) => {
          writeLinks({ fileApp: id });
        }}
      />
    </LinkGroup>
  );
}
