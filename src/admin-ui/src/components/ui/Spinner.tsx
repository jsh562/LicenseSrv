/** Decorative loading spinner (aria-hidden). */
export function Spinner({ size = "md" }: { size?: "sm" | "md" }): JSX.Element {
  const dim = size === "sm" ? "h-3.5 w-3.5 border-2" : "h-5 w-5 border-2";
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border-current border-t-transparent align-[-0.125em] ${dim}`}
    />
  );
}
