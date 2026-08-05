/**
 * Locating the Godot executable.
 *
 * "Wrong Godot path" is the single most common setup failure reported against
 * every Godot MCP server, so discovery tries hard before giving up, caches the
 * answer, and produces an error that says exactly what to do next.
 *
 * A .NET (Mono) build is detected here too, because editing a scene that has C#
 * scripts attached with a non-.NET binary silently destroys those attachments.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GodotAssistantError } from "../util/errors.js";

const execFileAsync = promisify(execFile);

export interface GodotBinary {
  path: string;
  version: string;
  /** Parsed `[major, minor, patch]`. */
  semver: [number, number, number];
  /** True for Mono/.NET builds, which are required for C# projects. */
  dotnet: boolean;
  /** How this binary was found, surfaced in `godot_status`. */
  source: string;
}

let cached: GodotBinary | null = null;

/** Candidate locations per platform, most likely first. */
function candidates(): Array<{ path: string; source: string }> {
  const home = homedir();
  const list: Array<{ path: string; source: string }> = [];
  const add = (p: string, source: string) => list.push({ path: p, source });

  switch (platform()) {
    case "darwin":
      add("/Applications/Godot.app/Contents/MacOS/Godot", "standard install");
      add("/Applications/Godot_mono.app/Contents/MacOS/Godot", "standard install (.NET)");
      add(path.join(home, "Applications/Godot.app/Contents/MacOS/Godot"), "user Applications");
      add(
        path.join(home, "Applications/Godot_mono.app/Contents/MacOS/Godot"),
        "user Applications (.NET)",
      );
      add("/opt/homebrew/bin/godot", "homebrew");
      add("/usr/local/bin/godot", "local bin");
      break;
    case "win32": {
      const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
      const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData\\Local");
      add(path.join(programFiles, "Godot", "Godot.exe"), "Program Files");
      add(path.join(localAppData, "Programs", "Godot", "Godot.exe"), "local programs");
      add(path.join(home, "scoop", "shims", "godot.exe"), "scoop");
      break;
    }
    default:
      add("/usr/bin/godot", "system");
      add("/usr/local/bin/godot", "local bin");
      add("/snap/bin/godot", "snap");
      add(path.join(home, ".local/bin/godot"), "user bin");
      add(
        path.join(home, ".local/share/flatpak/exports/bin/org.godotengine.Godot"),
        "flatpak (user)",
      );
      add("/var/lib/flatpak/exports/bin/org.godotengine.Godot", "flatpak (system)");
      break;
  }

  // Names to try on PATH, covering the common versioned aliases.
  for (const name of ["godot", "godot4", "Godot", "godot-4", "godot_mono"]) {
    add(name, "PATH");
  }
  return list;
}

/**
 * Runs `--version` and parses the result. This is the only reliable way to tell
 * a working Godot binary from a same-named script or a stale symlink.
 */
async function probe(binary: string, source: string): Promise<GodotBinary | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: 15_000,
      // Never inherit cwd: under some MCP hosts process.cwd() is unset, and an
      // unset cwd makes every subsequent Godot invocation fail to resolve res://.
      cwd: homedir(),
      windowsHide: true,
    });
    const version = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (!m) return null;
    return {
      path: binary,
      version,
      semver: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)],
      dotnet: /mono|dotnet/i.test(version),
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves the Godot binary, preferring an explicit override.
 * @param override `GODOT_PATH` or `--godot`, which skips discovery entirely.
 */
export async function locateGodot(override?: string): Promise<GodotBinary> {
  if (cached && !override) return cached;

  if (override) {
    const resolved = resolveAppBundle(override);
    const found = await probe(resolved, "GODOT_PATH");
    if (!found) {
      throw new GodotAssistantError(
        `The configured Godot path is not a working Godot executable: ${override}`,
        `Check that the path exists and runs. On macOS point at the binary inside the app bundle, not the .app folder:\n  /Applications/Godot.app/Contents/MacOS/Godot\nVerify with:  "${resolved}" --version`,
      );
    }
    cached = found;
    return found;
  }

  for (const candidate of candidates()) {
    // Skip absolute paths that plainly do not exist; bare names fall through to
    // PATH resolution inside execFile.
    if (path.isAbsolute(candidate.path) && !existsSync(candidate.path)) continue;
    const found = await probe(candidate.path, candidate.source);
    if (found) {
      cached = found;
      return found;
    }
  }

  throw new GodotAssistantError(
    "Could not find a Godot executable.",
    [
      "Install Godot 4 from https://godotengine.org/download, then either:",
      "  1. put it on your PATH as `godot`, or",
      "  2. set GODOT_PATH to the executable, e.g.",
      platform() === "darwin"
        ? '     GODOT_PATH="/Applications/Godot.app/Contents/MacOS/Godot"'
        : platform() === "win32"
          ? '     GODOT_PATH="C:\\Program Files\\Godot\\Godot.exe"'
          : '     GODOT_PATH="/usr/local/bin/godot"',
      "Then restart your MCP client.",
    ].join("\n"),
  );
}

/** Accepts a macOS .app folder and points at the executable inside it. */
function resolveAppBundle(p: string): string {
  if (p.endsWith(".app")) {
    const inner = path.join(p, "Contents", "MacOS", "Godot");
    if (existsSync(inner)) return inner;
  }
  return p;
}

/** Godot 3 lacks most of the APIs the engine-side scripts rely on. */
export function assertSupportedVersion(binary: GodotBinary): void {
  if (binary.semver[0] < 4) {
    throw new GodotAssistantError(
      `Godot ${binary.version} is not supported (Godot 4.0 or newer is required).`,
      "Install Godot 4 from https://godotengine.org/download and set GODOT_PATH to it.",
    );
  }
}

/** Test seam. */
export function resetGodotCache(): void {
  cached = null;
}
