/**
 * Path resolution and confinement.
 *
 * Every path that reaches this server originates from a model, and a model can
 * be steered by whatever it just read from a web page or a source file. So all
 * paths are treated as hostile input: they are normalised, then proven to
 * resolve inside the project root, with symlinks followed *before* the check so
 * a link cannot be used to step outside.
 *
 * Prior art here got this wrong in ways worth naming, because the fixes below
 * are direct responses:
 *   - substring checks for ".." miss encoded and absolute-path escapes
 *   - a NUL byte can truncate a path inside a C-backed syscall
 *   - checking the link path rather than its target lets a symlink escape
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { GodotAssistantError } from "./errors.js";

/** Godot's virtual project-root scheme. */
export const RES_PREFIX = "res://";
/** Godot's per-user writable data scheme. */
export const USER_PREFIX = "user://";

export function isResPath(p: string): boolean {
  return p.startsWith(RES_PREFIX);
}

/**
 * Normalises any accepted spelling of a project-relative path to `res://x/y`.
 * Accepts `res://x/y`, `x/y`, `./x/y`, and `/abs/project/x/y`.
 */
export function toResPath(input: string, projectRoot: string): string {
  const raw = input.trim();
  assertSafeInput(raw);

  if (raw.startsWith(USER_PREFIX)) {
    throw new GodotAssistantError(
      `user:// paths are not addressable from outside the engine: ${raw}`,
      "Use a res:// path. Runtime user:// data is reachable through run_project output instead.",
    );
  }

  let relative: string;
  if (isResPath(raw)) {
    relative = raw.slice(RES_PREFIX.length);
  } else if (path.isAbsolute(raw)) {
    const rel = path.relative(projectRoot, raw);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new GodotAssistantError(
        `Path is outside the project: ${raw}`,
        `Paths must be inside the project root (${projectRoot}). Use a res:// path.`,
      );
    }
    relative = rel;
  } else {
    relative = raw;
  }

  // POSIX-normalise; res:// always uses forward slashes regardless of host OS.
  const normalized = path.posix.normalize(relative.split(path.sep).join("/")).replace(/^\/+/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new GodotAssistantError(
      `Path escapes the project root: ${raw}`,
      "Reference files inside the project only.",
    );
  }
  return RES_PREFIX + normalized;
}

/**
 * Converts a project path to an absolute host path, proving it stays inside the
 * project. `mustExist` controls whether symlinks are resolved on the full path
 * (reads) or only on the parent directory (writes to new files).
 */
export function toHostPath(input: string, projectRoot: string, mustExist = false): string {
  const res = toResPath(input, projectRoot);
  const relative = res.slice(RES_PREFIX.length);
  const absolute = path.resolve(projectRoot, relative);

  const rootReal = safeRealpath(projectRoot);
  const check = mustExist ? safeRealpath(absolute) : safeRealpath(path.dirname(absolute));

  const rel = path.relative(rootReal, check);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new GodotAssistantError(
      `Path resolves outside the project root: ${input}`,
      "This can happen when a symlink points outside the project. Only files under the project root can be accessed.",
    );
  }
  return absolute;
}

/** realpath that degrades to a lexical resolve for paths that do not exist yet. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Rejects the input classes that have historically defeated path validation.
 */
export function assertSafeInput(p: string): void {
  if (!p) {
    throw new GodotAssistantError("Empty path.");
  }
  if (p.includes("\0")) {
    // A NUL can truncate the string inside a C-level syscall, so the path that
    // gets validated and the path that gets opened differ.
    throw new GodotAssistantError("Path contains a NUL byte.", "Remove the embedded null character.");
  }
  if (p.length > 4096) {
    throw new GodotAssistantError("Path exceeds 4096 characters.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !isResPath(p) && !p.startsWith(USER_PREFIX)) {
    throw new GodotAssistantError(
      `Unsupported URI scheme: ${p}`,
      "Only res:// paths and paths inside the project are accepted.",
    );
  }
}

/**
 * Validates a Godot class name before it is handed to `ClassDB.instantiate`.
 *
 * Without this, a `nodeType` of `res://payload.gd` reaches `load()` on the
 * engine side and executes attacker-chosen GDScript inside the Godot process.
 * Restricting the shape to a bare identifier makes that unreachable; the engine
 * side additionally verifies the name against ClassDB.
 */
export function assertClassName(name: string, field = "type"): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new GodotAssistantError(
      `Invalid ${field}: ${JSON.stringify(name)}`,
      "Must be a bare engine class name such as Node2D, CharacterBody2D or Control. Paths and expressions are rejected. To use a custom script, create the node then attach the script with node_modify.",
    );
  }
  return trimmed;
}

/**
 * Validates a node path within a scene (`.`, `Player`, `UI/HUD/Label`).
 * Absolute (`/root/...`) and parent (`..`) forms are rejected: scene-file edits
 * are always relative to the scene root.
 */
export function assertNodePath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === ".") return ".";
  if (!trimmed) throw new GodotAssistantError("Empty node path.");
  if (trimmed.startsWith("/")) {
    throw new GodotAssistantError(
      `Absolute node path not allowed here: ${p}`,
      "Use a path relative to the scene root, e.g. \"UI/HUD\", or \".\" for the root itself.",
    );
  }
  if (trimmed.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) {
    throw new GodotAssistantError(
      `Invalid node path: ${p}`,
      'Use a simple relative path such as "UI/HUD".',
    );
  }
  return trimmed;
}

/** Node names may not contain the characters Godot reserves for path syntax. */
export function assertNodeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new GodotAssistantError("Empty node name.");
  if (/[.:@/"%]/.test(trimmed)) {
    throw new GodotAssistantError(
      `Invalid node name: ${JSON.stringify(name)}`,
      'Node names cannot contain . : @ / " or %.',
    );
  }
  return trimmed;
}

/** Extension check with a clear message, used to keep tools honest about input. */
export function assertExtension(p: string, allowed: string[], what: string): void {
  const ext = path.posix.extname(p).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new GodotAssistantError(
      `${what} must have extension ${allowed.join(" or ")}, got "${ext || "(none)"}": ${p}`,
    );
  }
}
