import type { ButtonHTMLAttributes } from "react";

import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary/90 disabled:bg-primary/50",
  secondary: "border border-border bg-surface hover:bg-surface-muted",
  ghost: "hover:bg-surface-muted",
  danger: "bg-danger text-white hover:bg-danger/90 disabled:bg-danger/50",
};
const SIZES: Record<Size, string> = { sm: "px-2.5 py-1 text-xs", md: "px-3.5 py-2 text-sm" };

/** A styled button. Spreads all native attrs (type/onClick/disabled/aria-*) so pages pass them through. */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  children,
  disabled,
  ...rest
}: { variant?: Variant; size?: Size; loading?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}
