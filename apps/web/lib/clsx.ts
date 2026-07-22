type ClassValue = string | number | null | undefined | false | Record<string, boolean>;

/** Minimal classnames joiner — avoids pulling in a dependency for one function. */
export function clsx(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string" || typeof value === "number") {
      out.push(String(value));
    } else {
      for (const [key, condition] of Object.entries(value)) {
        if (condition) out.push(key);
      }
    }
  }
  return out.join(" ");
}
