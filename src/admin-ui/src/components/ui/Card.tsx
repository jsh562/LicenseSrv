import type { HTMLAttributes } from "react";

/** A surface panel with border + subtle shadow. */
export function Card({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={`rounded-lg border border-border bg-surface p-4 shadow-sm ${className}`}
      {...rest}
    />
  );
}
