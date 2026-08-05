/**
 * Output formatting helpers.
 *
 * Everything an MCP tool returns is billed to the caller's context window, so
 * this module exists to make responses as small as they can be while staying
 * unambiguous. The rules we follow throughout:
 *
 *   - Plain text over JSON. JSON spends ~30-40% of its bytes on punctuation and
 *     repeated keys that a model does not need in order to read a list.
 *   - Elide defaults. A property at its engine default carries no information.
 *   - Truncate with a resumption hint, never silently.
 */

/** Hard ceiling for a single tool response, in characters (~25k tokens). */
export const MAX_RESPONSE_CHARS = 100_000;

/** Default page size for list-shaped tools. */
export const DEFAULT_PAGE = 200;

export function truncate(text: string, limit = MAX_RESPONSE_CHARS): string {
  if (text.length <= limit) return text;
  const keep = text.slice(0, limit);
  // Cut at a line boundary so we never emit a half-written record.
  const lastNewline = keep.lastIndexOf("\n");
  const body = lastNewline > limit * 0.8 ? keep.slice(0, lastNewline) : keep;
  const omitted = text.length - body.length;
  return `${body}\n… truncated, ${omitted} more characters. Narrow the query (filter//pattern/path) to see the rest.`;
}

/**
 * Renders a page of items plus a resumption footer.
 * The footer is what lets an agent continue without re-listing from zero.
 */
export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
  render: (item: T) => string,
): string {
  const total = items.length;
  const start = Math.max(0, offset);
  const page = items.slice(start, start + limit);
  const lines = page.map(render);
  const end = start + page.length;
  if (end < total) {
    lines.push(`… ${total - end} more (total ${total}). Continue with offset=${end}.`);
  } else if (total === 0) {
    lines.push("(none)");
  }
  return lines.join("\n");
}

/**
 * Aligned two-or-more column table. Cheaper to read than JSON and far cheaper
 * than repeating a key on every row.
 */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return "(none)";
  const width: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      width[i] = Math.max(width[i] ?? 0, cell.length);
    });
  }
  const fmt = (row: string[]) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(width[i] ?? 0)))
      .join("  ")
      .trimEnd();
  const out = all.map(fmt);
  if (headers) out.splice(1, 0, width.map((w) => "-".repeat(w)).join("  "));
  return out.join("\n");
}

/** Key-value block, skipping empty values. */
export function kv(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${stringifyValue(v)}`)
    .join("\n");
}

/** Compact scalar rendering; arrays inline, objects as JSON only when needed. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).join(", ");
  return JSON.stringify(value);
}

export function section(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `## ${title}\n${trimmed}`;
}

/** Joins sections, dropping empties, with exactly one blank line between. */
export function joinSections(...parts: Array<string | undefined | null>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Indent every line by `depth` levels of two spaces. */
export function indent(text: string, depth = 1): string {
  const pad = "  ".repeat(depth);
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}
