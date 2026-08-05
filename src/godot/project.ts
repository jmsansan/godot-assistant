/**
 * Godot project discovery and `project.godot` parsing.
 *
 * `project.godot` is a Godot-flavoured INI file. We parse it directly rather
 * than booting the engine because project metadata is requested constantly and
 * a headless engine launch costs roughly a second each time.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { GodotAssistantError } from "../util/errors.js";

export interface ProjectInfo {
  /** Absolute path to the directory containing project.godot. */
  root: string;
  name: string;
  /** Engine feature tags, e.g. ["4.4", "Forward Plus"]. */
  features: string[];
  mainScene?: string;
  /** Autoload name -> res:// path (a leading "*" marks a singleton). */
  autoloads: Record<string, string>;
  /** Input action name -> human summary of its bound events. */
  inputActions: Record<string, string>;
  renderingMethod?: string;
  /** True when the project is configured for C#. */
  dotnet: boolean;
  raw: Record<string, Record<string, string>>;
}

/**
 * Walks up from `start` looking for project.godot.
 * Accepts either the project directory itself or any path inside it, which
 * removes a whole class of "point it at the right folder" support questions.
 */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  try {
    if (statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    return null;
  }

  const stopAt = path.parse(dir).root;
  for (let i = 0; i < 64; i++) {
    if (existsSync(path.join(dir, "project.godot"))) return dir;
    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolves and validates a project root, with a directed error when missing. */
export function requireProjectRoot(candidate: string | undefined, fallback?: string): string {
  const start = candidate ?? fallback;
  if (!start) {
    throw new GodotAssistantError(
      "No Godot project specified.",
      "Pass `project` with the path to your project (the folder containing project.godot), or start the server with --project so it is implied.",
    );
  }
  const root = findProjectRoot(start);
  if (!root) {
    throw new GodotAssistantError(
      `No project.godot found at or above: ${start}`,
      "Point `project` at your Godot project folder — the one containing project.godot.",
    );
  }
  return root;
}

/**
 * Parses the Godot INI dialect: `[section]` headers, `key=value` pairs, values
 * that may be quoted strings, numbers, booleans or constructor expressions such
 * as `PackedStringArray("a", "b")`. Multi-line values (nested dictionaries in
 * input maps) are joined by tracking bracket depth.
 */
export function parseProjectFile(content: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = "";
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? "").trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      result[section] ??= {};
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Join continuation lines until brackets and braces balance out.
    let depth = bracketDepth(value);
    while (depth > 0 && i + 1 < lines.length) {
      const next = lines[++i] ?? "";
      value += " " + next.trim();
      depth += bracketDepth(next);
    }

    result[section] ??= {};
    result[section]![key] = value;
  }
  return result;
}

function bracketDepth(s: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
  }
  return depth;
}

/** Strips surrounding quotes from an INI value. */
export function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return t;
}

/** Extracts the string literals out of `PackedStringArray("a", "b")`. */
export function parseStringArray(value: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push((m[1] ?? "").replace(/\\"/g, '"'));
  return out;
}

/** Reads and interprets project.godot. */
export function loadProject(root: string): ProjectInfo {
  const file = path.join(root, "project.godot");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    throw new GodotAssistantError(
      `Cannot read ${file}`,
      "Check that the path is a Godot project folder and is readable.",
    );
  }

  const raw = parseProjectFile(content);
  const application = raw["application"] ?? {};

  const autoloads: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw["autoload"] ?? {})) {
    autoloads[key] = unquote(value);
  }

  const inputActions: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw["input"] ?? {})) {
    inputActions[key] = summariseInputAction(value);
  }

  const features = parseStringArray(application["config/features"] ?? "");

  return {
    root,
    name: unquote(application["config/name"] ?? path.basename(root)),
    features,
    mainScene: application["run/main_scene"] ? unquote(application["run/main_scene"]) : undefined,
    autoloads,
    inputActions,
    renderingMethod: raw["rendering"]?.["renderer/rendering_method"]
      ? unquote(raw["rendering"]["renderer/rendering_method"]!)
      : undefined,
    dotnet: detectDotnet(root, raw),
    raw,
  };
}

/**
 * Detects a C# project. Editing scenes in such a project with a non-.NET Godot
 * build drops every C# script attachment on save, so callers gate on this.
 */
function detectDotnet(root: string, raw: Record<string, Record<string, string>>): boolean {
  if (raw["dotnet"]) return true;
  try {
    return readdirSync(root).some((f) => f.endsWith(".csproj") || f.endsWith(".sln"));
  } catch {
    return false;
  }
}

/** Condenses an input-map entry into a readable list of bound events. */
function summariseInputAction(value: string): string {
  const events: string[] = [];
  for (const m of value.matchAll(/Object\(Input(\w+?),([^)]*)\)/g)) {
    const kind = m[1] ?? "";
    const body = m[2] ?? "";
    if (kind === "EventKey") {
      const keycode = /"(?:physical_)?keycode":(\d+)/.exec(body)?.[1];
      events.push(keycode ? `key ${keyName(Number(keycode))}` : "key");
    } else if (kind === "EventMouseButton") {
      const idx = /"button_index":(\d+)/.exec(body)?.[1];
      events.push(`mouse ${idx ?? "?"}`);
    } else if (kind === "EventJoypadButton") {
      const idx = /"button_index":(\d+)/.exec(body)?.[1];
      events.push(`pad ${idx ?? "?"}`);
    } else if (kind === "EventJoypadMotion") {
      events.push("pad axis");
    }
  }
  return events.length ? events.join(", ") : "(no events)";
}

/** Names for the keycodes that actually show up in game input maps. */
const KEY_NAMES: Record<number, string> = {
  32: "Space", 4194305: "Escape", 4194309: "Enter", 4194310: "KpEnter", 4194306: "Tab",
  4194308: "Backspace", 4194312: "Left", 4194313: "Up", 4194314: "Right", 4194315: "Down",
  4194321: "Home", 4194322: "End", 4194319: "PageUp", 4194320: "PageDown", 4194326: "Shift",
  4194328: "Ctrl", 4194327: "Alt", 4194332: "Meta", 4194318: "Delete",
};

function keyName(code: number): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code]!;
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  if (code >= 4194332 && code <= 4194354) return `F${code - 4194331}`;
  return `#${code}`;
}
