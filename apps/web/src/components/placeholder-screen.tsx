import type { ReactNode } from "react";
import { useDocumentTitle } from "../lib/document-title";

type PlaceholderScreenProps = {
  title: string;
  summary: string;
};

export function PlaceholderScreen({ title, summary }: PlaceholderScreenProps): ReactNode {
  useDocumentTitle(title);

  return (
    <>
      <h1 className="font-chrome text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 mb-7 text-base text-muted">{summary}</p>
    </>
  );
}
