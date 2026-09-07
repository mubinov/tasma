import type { ReactNode } from "react";

type SectionHeadingProps = {
  children: ReactNode;
  /** Set where the section's list is labelled by the heading. */
  id?: string;
};

/** Opens one section of a screen, below the single `<h1>` the screen starts with. */
export function SectionHeading({ children, id }: SectionHeadingProps): ReactNode {
  return (
    <h2 id={id} className="mt-7 font-chrome text-sm font-medium">
      {children}
    </h2>
  );
}
