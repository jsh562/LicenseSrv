import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";

/** Styled wrappers over native table elements — the DOM stays real `<table>/<tr>/<td>` so tests that
 *  use `.closest("tr")` / row queries keep working. */
export function Table({ className = "", ...rest }: TableHTMLAttributes<HTMLTableElement>): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className={`w-full border-collapse text-sm ${className}`} {...rest} />
    </div>
  );
}

export function THead(props: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return <thead className="bg-surface-muted text-left text-xs uppercase tracking-wide text-fg-muted" {...props} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return <tbody className="divide-y divide-border" {...props} />;
}

export function Tr({ className = "", ...rest }: HTMLAttributes<HTMLTableRowElement>): JSX.Element {
  return <tr className={`hover:bg-surface-muted/50 ${className}`} {...rest} />;
}

export function Th({ className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return <th className={`px-3 py-2 font-medium ${className}`} {...rest} />;
}

export function Td({ className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return <td className={`px-3 py-2 align-middle ${className}`} {...rest} />;
}
