import type { HTMLAttributes } from "react";

export type Tone = "success" | "warning" | "danger" | "info" | "muted";

const TONES: Record<Tone, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  muted: "bg-muted/15 text-fg-muted",
};

/** A small status pill. Renders its children text verbatim (tests match on the text). */
export function Badge({
  tone = "muted",
  className = "",
  ...rest
}: { tone?: Tone } & HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
      {...rest}
    />
  );
}

/** Map a domain status string to a semantic tone (license/lease/reseller/user/key states). */
export function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (["active", "verified", "valid", "live", "ready", "reinstated"].includes(s)) return "success";
  if (["suspended", "pending", "invited", "grace", "offboarding", "preview", "past_due"].includes(s)) return "warning";
  if (["revoked", "failed", "deactivated", "expired", "disabled", "canceled", "cancelled"].includes(s)) return "danger";
  if (["perpetual", "enforced", "dry_run"].includes(s)) return "info";
  return "muted";
}
