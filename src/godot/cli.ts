/**
 * Invoking the Godot binary.
 *
 * Two invariants hold for every call made through this module:
 *
 *   1. A hard timeout, always. Godot can and does hang — awaiting a rendered
 *      frame under `--headless` never resolves, for instance — and a hung child
 *      would otherwise wedge the MCP session with no diagnostic.
 *   2. An explicit `cwd`, always. Some MCP hosts spawn servers with no working
 *      directory; `process.cwd()` then throws or returns null and every res://
 *      lookup inside Godot fails with a baffling "can't open res://project.godot".
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GodotAssistantError, parseGodotOutput, type Diagnostic } from "../util/errors.js";
import { locateGodot, assertSupportedVersion, type GodotBinary } from "./locate.js";

/** Directory holding the GDScript payloads shipped with this package. */
export const GDSCRIPT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "godot",
);

export const OPS_SCRIPT = path.join(GDSCRIPT_DIR, "ops.gd");
export const CAPTURE_SCRIPT = path.join(GDSCRIPT_DIR, "capture.gd");
export const ADDON_DIR = path.join(GDSCRIPT_DIR, "addon");

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** True when the process was killed for exceeding its timeout. */
  timedOut: boolean;
  diagnostics: Diagnostic[];
  /** Non-diagnostic console lines, i.e. the project's own print() output. */
  output: string[];
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** Receives lines as they arrive, for long-running processes. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Spawns Godot and resolves once it exits or the timeout fires. */
export async function runGodot(args: string[], options: RunOptions): Promise<RunResult> {
  const binary = await locateGodot(process.env["GODOT_PATH"]);
  assertSupportedVersion(binary);
  return runBinary(binary, args, options);
}

export async function runBinary(
  binary: GodotBinary,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary.path, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new GodotAssistantError(
          `Failed to start Godot: ${(error as Error).message}`,
          `Verify that "${binary.path}" is executable.`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const collect = (stream: "stdout" | "stderr") => {
      let partial = "";
      return (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (stream === "stdout") stdout += text;
        else stderr += text;
        if (options.onLine) {
          partial += text;
          const lines = partial.split(/\r?\n/);
          partial = lines.pop() ?? "";
          for (const line of lines) options.onLine(line, stream);
        }
      };
    };

    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      const { diagnostics, output } = parseGodotOutput(combined);
      resolve({ stdout, stderr, code, timedOut, diagnostics, output });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new GodotAssistantError(
          `Godot process error: ${error.message}`,
          `Verify that "${binary.path}" is a working Godot executable.`,
        ),
      );
    });
    child.on("close", finish);
  });
}

/**
 * Terminates a child, escalating to SIGKILL if it ignores the polite request.
 * Godot occasionally blocks in a driver call where SIGTERM is not serviced.
 */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

/**
 * Runs one operation from the bundled `ops.gd` dispatcher.
 *
 * The script lives outside the project and is passed by absolute path, so the
 * user's project is never modified just to perform a read. Parameters travel as
 * a single JSON blob after `--`, which keeps them out of shell interpretation
 * entirely (there is no shell: `spawn` is used without `shell: true`).
 */
export async function runOperation(
  operation: string,
  params: Record<string, unknown>,
  projectRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<{ result: OperationResult; raw: RunResult }> {
  const payload = JSON.stringify({ op: operation, params });

  const raw = await runGodot(
    ["--headless", "--path", projectRoot, "--script", OPS_SCRIPT, "--", payload],
    { cwd: projectRoot, timeoutMs: options.timeoutMs ?? 90_000 },
  );

  if (raw.timedOut) {
    throw new GodotAssistantError(
      `Godot timed out running "${operation}" after ${(options.timeoutMs ?? 90_000) / 1000}s.`,
      "This usually means the project failed to import. Run `godot_status` to check the project, or open the editor once so Godot can build its import cache.",
    );
  }

  const result = extractResult(raw.stdout, operation, raw);
  return { result, raw };
}

export interface OperationResult {
  ok: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

/**
 * `ops.gd` brackets its JSON reply with sentinels. Godot writes plenty of
 * unrelated text to stdout (banner, import chatter, engine warnings), so
 * sentinels are the only dependable way to find the payload.
 */
const BEGIN = "<<<GODOT_ASSISTANT_RESULT";
const END = "GODOT_ASSISTANT_RESULT>>>";

function extractResult(stdout: string, operation: string, raw: RunResult): OperationResult {
  const start = stdout.indexOf(BEGIN);
  const end = stdout.indexOf(END);

  if (start === -1 || end === -1 || end < start) {
    // No payload: the engine died before the script could reply. The parsed
    // diagnostics are far more useful here than the raw dump.
    const diagnostics = raw.diagnostics
      .filter((d) => d.severity !== "warning")
      .slice(0, 8)
      .map((d) => `  ${d.message}${d.file ? ` [${d.file}:${d.line ?? "?"}]` : ""}`)
      .join("\n");

    throw new GodotAssistantError(
      `Godot did not return a result for "${operation}".${diagnostics ? `\n\nGodot reported:\n${diagnostics}` : ""}`,
      "Most often the project has a script or resource that fails to load. Run `script_validate` to find parse errors, then retry.",
    );
  }

  const json = stdout.slice(start + BEGIN.length, end).trim();
  try {
    return JSON.parse(json) as OperationResult;
  } catch {
    throw new GodotAssistantError(
      `Malformed response from Godot for "${operation}".`,
      "This is a bug in godot-assistant. Please report it with the operation name.",
    );
  }
}

/** Runs an operation and raises a directed error when the engine reports failure. */
export async function operation(
  op: string,
  params: Record<string, unknown>,
  projectRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<OperationResult> {
  const { result } = await runOperation(op, params, projectRoot, options);
  if (!result.ok) {
    throw new GodotAssistantError(result.error ?? `Operation "${op}" failed.`, result.hint);
  }
  return result;
}
