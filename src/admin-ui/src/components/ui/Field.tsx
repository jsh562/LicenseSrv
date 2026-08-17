import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

const CONTROL =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-fg-muted focus:border-primary disabled:opacity-60";

/** Label + control wrapper. Keeps the `<label>Text<control/></label>` association so getByLabelText works. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input className={`${CONTROL} ${className}`} {...rest} />;
}

export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select className={`${CONTROL} ${className}`} {...rest} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={`${CONTROL} font-mono ${className}`} {...rest} />;
}
