/**
 * Lifecycle and log capture for Godot processes launched by this server.
 *
 * Output is buffered rather than streamed straight back, because a game that
 * logs each frame produces far more text than any context window can hold. The
 * buffer is a bounded ring, and `get_output` reads from it on demand.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { GodotAssistantError, parseGodotOutput, type Diagnostic } from "../util/errors.js";
import { killTree } from "./cli.js";
import { locateGodot } from "./locate.js";

/** Ring capacity. Roughly 1 MB of text at typical line lengths. */
const MAX_LINES = 8000;

export type SessionKind = "project" | "scene" | "editor";

export interface Session {
  id: string;
  kind: SessionKind;
  projectRoot: string;
  target?: string;
  child: ChildProcess;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lines: string[];
  /** Count of lines dropped by the ring buffer, reported so nothing looks silently complete. */
  dropped: number;
  headless: boolean;
}

const sessions = new Map<string, Session>();
let counter = 0;

function key(projectRoot: string, kind: SessionKind): string {
  return `${kind}:${projectRoot}`;
}

export function getSession(projectRoot: string, kind: SessionKind): Session | undefined {
  return sessions.get(key(projectRoot, kind));
}

export function listSessions(): Session[] {
  return [...sessions.values()];
}

export function isRunning(session: Session | undefined): session is Session {
  return !!session && session.exitedAt === undefined;
}

export interface LaunchOptions {
  projectRoot: string;
  kind: SessionKind;
  args: string[];
  target?: string;
  headless: boolean;
  /** Replace an existing session of the same kind rather than refusing. */
  replace?: boolean;
}

/**
 * Starts a Godot process and returns once it is confirmed running (or has
 * already failed).
 *
 * The brief settle wait matters: a project whose main scene fails to parse dies
 * within a few hundred milliseconds, and reporting "started successfully" for a
 * process that is already dead is exactly the behaviour that makes agents chase
 * ghosts. Here that case comes back as a failure with the parse errors attached.
 */
export async function launch(options: LaunchOptions): Promise<Session> {
  const existing = getSession(options.projectRoot, options.kind);
  if (isRunning(existing)) {
    if (!options.replace) {
      throw new GodotAssistantError(
        `A ${options.kind} is already running for this project (started ${Math.round((Date.now() - existing.startedAt) / 1000)}s ago).`,
        "Call stop_project first, or pass replace=true to restart it.",
      );
    }
    await stop(options.projectRoot, options.kind);
  }

  const binary = await locateGodot(process.env["GODOT_PATH"]);
  const child = spawn(binary.path, options.args, {
    cwd: options.projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const session: Session = {
    id: `${options.kind}-${++counter}`,
    kind: options.kind,
    projectRoot: options.projectRoot,
    target: options.target,
    child,
    startedAt: Date.now(),
    lines: [],
    dropped: 0,
    headless: options.headless,
  };

  const push = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      session.lines.push(line);
      if (session.lines.length > MAX_LINES) {
        session.lines.shift();
        session.dropped++;
      }
    }
  };

  child.stdout?.on("data", (c: Buffer) => push(c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => push(c.toString("utf8")));

  child.on("close", (code, signal) => {
    session.exitedAt = Date.now();
    session.exitCode = code;
    session.signal = signal;
  });

  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError = error;
    session.exitedAt = Date.now();
  });

  sessions.set(key(options.projectRoot, options.kind), session);

  await settle(session, 1200);

  if (spawnError) {
    throw new GodotAssistantError(
      `Failed to start Godot: ${(spawnError as Error).message}`,
      `Check that "${binary.path}" is executable.`,
    );
  }

  if (session.exitedAt !== undefined && (session.exitCode ?? 0) !== 0) {
    const { diagnostics } = parseGodotOutput(session.lines.join("\n"));
    const detail = diagnostics
      .filter((d) => d.severity !== "warning")
      .slice(0, 10)
      .map((d) => `  ${d.message}${d.file ? ` [${d.file}:${d.line ?? "?"}]` : ""}`)
      .join("\n");
    throw new GodotAssistantError(
      `Godot exited immediately with code ${session.exitCode}.${detail ? `\n\nGodot reported:\n${detail}` : ""}`,
      "Fix the reported errors and try again. `script_validate` lists every parse error in the project at once.",
    );
  }

  return session;
}

/** Waits up to `ms` for early exit, resolving as soon as the process dies. */
function settle(session: Session, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (session.exitedAt !== undefined) return resolve();
    const timer = setTimeout(resolve, ms);
    session.child.once("close", () => {
      clearTimeout(timer);
      // Let the final stdout chunks flush before we read the buffer.
      setTimeout(resolve, 120);
    });
  });
}

/**
 * Stops a session and waits for the process to actually be gone.
 *
 * Returning before the process has exited causes a restart to race the old
 * instance for the debug port and for file locks.
 */
export async function stop(projectRoot: string, kind: SessionKind): Promise<Session | null> {
  const session = getSession(projectRoot, kind);
  if (!isRunning(session)) return session ?? null;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 8000);
    session.child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    killTree(session.child);
  });

  session.exitedAt ??= Date.now();
  return session;
}

export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => stop(s.projectRoot, s.kind)));
}

export interface OutputView {
  diagnostics: Diagnostic[];
  output: string[];
  dropped: number;
  running: boolean;
  exitCode?: number | null;
  runtimeMs: number;
}

/** Parsed, deduplicated view of a session's captured output. */
export function readOutput(session: Session): OutputView {
  const { diagnostics, output } = parseGodotOutput(session.lines.join("\n"));
  return {
    diagnostics,
    output,
    dropped: session.dropped,
    running: session.exitedAt === undefined,
    exitCode: session.exitCode,
    runtimeMs: (session.exitedAt ?? Date.now()) - session.startedAt,
  };
}

/** Clears the buffer without stopping the process. */
export function clearOutput(session: Session): void {
  session.lines = [];
  session.dropped = 0;
}
