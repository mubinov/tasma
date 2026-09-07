import type { ReactNode } from "react";

type ScreenHeadingProps = {
  children: ReactNode;
  /** Set where something below the heading is labelled by it. */
  id?: string;
};

export function ScreenHeading({ children, id }: ScreenHeadingProps): ReactNode {
  return (
    <h1 id={id} className="font-chrome text-xl font-semibold tracking-tight">
      {children}
    </h1>
  );
}
