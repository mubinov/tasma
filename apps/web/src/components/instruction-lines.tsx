import type { ReactNode } from "react";

export function NoValue(): ReactNode {
  return <span className="text-sm text-dim">None</span>;
}

export function InstructionLines({ paths }: { paths: readonly string[] }): ReactNode {
  if (paths.length === 0) {
    return <NoValue />;
  }

  return paths.map((path, index) => (
    // eslint-disable-next-line @eslint-react/no-array-index-key
    <span key={index} className="block font-mono text-sm wrap-anywhere">
      {path}
    </span>
  ));
}
