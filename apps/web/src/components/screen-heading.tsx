import type { ReactNode } from "react";

type ScreenHeadingProps = {
  children: ReactNode;
};

export function ScreenHeading({ children }: ScreenHeadingProps): ReactNode {
  return <h1 className="font-chrome text-xl font-semibold tracking-tight">{children}</h1>;
}
