import type { ReactNode } from "react";

type SectionHeadingProps = {
  children: ReactNode;
};

/** Opens one section of a screen, below the single `<h1>` the screen starts with. */
export function SectionHeading({ children }: SectionHeadingProps): ReactNode {
  return (
    <h2 className="mt-7 font-chrome text-sm font-medium">
      {children}
    </h2>
  );
}
