/**
 * Error types and the parser for Godot's console diagnostics.
 *
 * Godot writes errors, warnings and script-parse failures to stdout/stderr in a
 * multi-line format with engine-internal noise interleaved. Handing that raw to
 * a model is both expensive and misleading (leaked-RID warnings at shutdown are
 * normal and routinely send agents chasing imaginary bugs). We parse it into
 * structured diagnostics, drop the known-benign lines, and collapse duplicates.
 */

/** An error we raise ourselves, with an actionable remedy for the agent. */
export class GodotAssistantError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = "GodotAssistantError";
    this.remedy = remedy;
  }

  override toString(): string {
    return this.remedy ? `${this.message}\n\nFix: ${this.remedy}` : this.message;
  }
}

export type Severity = "error" | "warning" | "script";

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Project-relative or res:// path, when Godot reported one. */
  file?: string;
  line?: number;
  /** Innermost GDScript stack frames, outermost last. */
  stack?: string[];
  /** How many identical diagnostics were collapsed into this one. */
  count: number;
}

/**
 * Engine chatter that is either unconditionally emitted or is a normal
 * consequence of a short-lived headless run. None of it indicates a problem
 * with the user's project, and all of it costs tokens.
 */
const NOISE = [
  /^Godot Engine v[\d.]+/,
  /^OpenGL API /,
  /^Vulkan (API|\d)/,
  /^Metal \d/,
  /RIDs? (of type )?.*(were|was) leaked/i,
  /RID allocations of type .* were leaked at exit/i,
  /ObjectDB instances were leaked at exit/i,
  /^\s*at: (_free_rids|cleanup|_free_pending_resources)/,
  /Leaked instance: /,
  /Hint: You can use the `--verbose`/,
  /^--- Debug adapter server started/,
  /^--- GDScript language server started/,
  /^\s*$/,
];

function isNoise(line: string): boolean {
  return NOISE.some((re) => re.test(line));
}

/**
 * Strips ANSI escape sequences.
 *
 * Some Godot builds colourise diagnostics on stdout even when it is not a TTY —
 * 4.3 does, 4.7 does not. A colourised line begins with an escape sequence
 * rather than "SCRIPT ERROR:", so without this every diagnostic slips through
 * as plain output and errors lose their file and line attribution entirely.
 */
export function stripAnsi(text: string): string {
  // ESC is spelled \u001B so the literal control byte never has to survive a
  // round-trip through an editor or a patch file.
  return text
    .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "");
}

/** Matches `   at: func_name (path/to/file.gd:12)` trailers. */
const AT_RE = /^\s*at:\s+(?:(.+?)\s+)?\(([^()]+?):(\d+)\)\s*$/;
/** Matches `       [0] _ready (res://main.gd:4)` backtrace frames. */
const FRAME_RE = /^\s*\[(\d+)\]\s+(.+?)\s+\((.+?):(\d+)\)\s*$/;
/** Matches the `at: GDScript::reload (res://broken.gd:3)` form used by parse errors. */
const HEAD_RE = /^(SCRIPT ERROR|ERROR|WARNING|USER ERROR|USER WARNING):\s*(.*)$/;

/**
 * Splits raw Godot console output into diagnostics and plain program output.
 *
 * `print()` from the user's game is preserved verbatim in `output` — that is
 * usually the signal the agent actually asked for.
 */
export function parseGodotOutput(raw: string): {
  diagnostics: Diagnostic[];
  output: string[];
} {
  const lines = stripAnsi(raw).split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isNoise(line)) continue;

    const head = HEAD_RE.exec(line);
    if (!head) {
      output.push(line);
      continue;
    }

    const kind = head[1] ?? "ERROR";
    const severity: Severity = kind.includes("WARNING")
      ? "warning"
      : kind.startsWith("SCRIPT")
        ? "script"
        : "error";
    const diag: Diagnostic = { severity, message: (head[2] ?? "").trim(), count: 1 };

    // Consume the indented trailer block that belongs to this diagnostic.
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? "";
      if (!/^\s/.test(next) || next.trim() === "") break;

      const at = AT_RE.exec(next);
      const frame = FRAME_RE.exec(next);
      if (at) {
        // Prefer a res:// location over an engine C++ source location.
        const file = at[2] ?? "";
        if (!diag.file || (file.startsWith("res://") && !diag.file.startsWith("res://"))) {
          diag.file = file;
          diag.line = Number(at[3]);
        }
      } else if (frame) {
        (diag.stack ??= []).push(`${frame[2]} (${frame[3]}:${frame[4]})`);
        if (!diag.file?.startsWith("res://")) {
          diag.file = frame[3];
          diag.line = Number(frame[4]);
        }
      } else if (!/GDScript backtrace/.test(next)) {
        // A wrapped continuation of the message itself.
        diag.message += ` ${next.trim()}`;
      }
      i++;
    }

    diagnostics.push(diag);
  }

  return { diagnostics: dedupe(diagnostics), output };
}

/**
 * Collapses identical diagnostics. A missing node referenced inside `_process`
 * produces one error per frame; without this a three-second run can emit
 * thousands of copies of the same line.
 */
export function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const byKey = new Map<string, Diagnostic>();
  for (const d of diagnostics) {
    const key = `${d.severity}|${d.message}|${d.file ?? ""}|${d.line ?? ""}`;
    const existing = byKey.get(key);
    if (existing) existing.count++;
    else byKey.set(key, { ...d });
  }
  return [...byKey.values()];
}

/** One-line rendering of a diagnostic. */
export function formatDiagnostic(d: Diagnostic, includeStack = false): string {
  const tag = d.severity === "warning" ? "WARN " : "ERROR";
  const where = d.file ? ` [${d.file}${d.line ? `:${d.line}` : ""}]` : "";
  const times = d.count > 1 ? ` (x${d.count})` : "";
  let out = `${tag}${where} ${d.message}${times}`;
  if (includeStack && d.stack?.length) {
    out += `\n  via ${d.stack.join(" < ")}`;
  }
  return out;
}

export function formatDiagnostics(diagnostics: Diagnostic[], includeStack = false): string {
  if (diagnostics.length === 0) return "";
  return diagnostics.map((d) => formatDiagnostic(d, includeStack)).join("\n");
}
