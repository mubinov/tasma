import type { ReactNode } from "react";
import { useDocumentTitle } from "../lib/document-title";
import { ScreenHeading } from "./screen-heading";

type PlaceholderScreenProps = {
  title: string;
  summary: string;
};

export function PlaceholderScreen({ title, summary }: PlaceholderScreenProps): ReactNode {
  useDocumentTitle(title);

  return (
    <>
      <ScreenHeading>{title}</ScreenHeading>
      <p className="mt-2 mb-7 text-base text-muted">{summary}</p>
    </>
  );
}
