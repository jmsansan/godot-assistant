/**
 * Editor control and installation of the optional live bridge addon.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ADDON_DIR } from "../godot/cli.js";
import { bridgeStatus, requireBridge } from "../godot/bridge.js";
import { GodotAssistantError } from "../util/errors.js";
import { parseStringArray, loadProject } from "../godot/project.js";
import { launch, getSession, isRunning } from "../godot/process.js";
import { toResPath } from "../util/paths.js";
import { joinSections, section } from "../util/text.js";
import { guard, projectParam, text, type ToolContext } from "./common.js";

/** Where the addon lives inside a user project. */
const ADDON_SUBDIR = path.join("addons", "godot_assistant");
const PLUGIN_ENTRY = "res://addons/godot_assistant/plugin.cfg";

export function registerEditorTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bridge_install",
    {
      title: "Install live bridge addon",
      description:
        "Install (or remove) the optional Godot addon that enables live features: inspecting the running game, simulating input, screenshotting the game and editor, and driving play/stop. Everything else works without it. Adds files under addons/godot_assistant and enables the plugin.",
      inputSchema: {
        project: projectParam,
        action: z.enum(["install", "status", "uninstall"]).default("install"),
      },
    },
    guard(async ({ project, action }: { project?: string; action: string }) => {
      const root = ctx.project(project);
      const target = path.join(root, ADDON_SUBDIR);

      if (action === "status") {
        const installed = existsSync(path.join(target, "plugin.cfg"));
        const enabled = isPluginEnabled(root);
        const editor = bridgeStatus(root, "editor");
        const runtime = bridgeStatus(root, "runtime");
        return text(
          joinSections(
            section(
              "Addon",
              [
                `files installed: ${installed ? "yes" : "no"}`,
                `enabled in project.godot: ${enabled ? "yes" : "no"}`,
                `editor bridge: ${editor.available ? "connected" : editor.reason}`,
                `runtime bridge: ${runtime.available ? "connected" : runtime.reason}`,
              ].join("\n"),
            ),
            installed && enabled && !editor.available
              ? "The addon is installed and enabled but no editor is connected. Open this project in the Godot editor (or reload it) to activate the bridge."
              : "",
          ),
        );
      }

      ctx.assertWritable("bridge_install");

      if (action === "uninstall") {
        setPluginEnabled(root, false);
        setRuntimeAutoload(root, false);
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        for (const role of ["editor", "runtime"] as const) {
          const stale = path.join(root, ".godot", `godot-assistant-${role}.json`);
          if (existsSync(stale)) rmSync(stale, { force: true });
        }
        return text(
          "Removed addons/godot_assistant and disabled the plugin.\nRestart the Godot editor if it is open. Command-line features are unaffected.",
        );
      }

      mkdirSync(target, { recursive: true });
      const copied: string[] = [];
      for (const entry of readdirSync(ADDON_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        copyFileSync(path.join(ADDON_DIR, entry.name), path.join(target, entry.name));
        copied.push(entry.name);
      }
      setPluginEnabled(root, true);
      setRuntimeAutoload(root, true);

      const editorRunning = bridgeStatus(root, "editor").available;
      return text(
        joinSections(
          `Installed the godot-assistant addon into ${path.join(ADDON_SUBDIR)} (${copied.length} files) and enabled it.`,
          section(
            "What this adds",
            [
              "- screenshot(source='game') and source='editor'",
              "- simulate_input for the running game",
              "- runtime_inspect of the live node tree",
              "- editor_control: open scenes, play/stop, read editor state",
            ].join("\n"),
          ),
          section(
            "Next step",
            editorRunning
              ? "A Godot editor is already running. Reload the project (Project > Reload Current Project) so it picks up the new plugin."
              : "Open this project in the Godot editor to activate it. The plugin also registers an autoload so the running game can be inspected.",
          ),
          section(
            "Notes",
            [
              "- The bridge listens on 127.0.0.1 only, with a token regenerated each session.",
              "- It refuses to start in non-debug builds, so exported games are unaffected.",
              "- Remove it any time with action='uninstall'.",
            ].join("\n"),
          ),
        ),
      );
    }),
  );

  server.registerTool(
    "editor_control",
    {
      title: "Control the Godot editor",
      description:
        "Drive a running Godot editor: read what is open, open a scene, save, play/stop, select nodes, rescan the filesystem. Also launches the editor. Most actions need bridge_install.",
      inputSchema: {
        project: projectParam,
        action: z
          .enum(["launch", "state", "open_scene", "save_scene", "reload_scene", "play", "play_scene", "stop", "select", "rescan"])
          .describe("'launch' starts the editor; the rest drive one that is already running."),
        scene: z.string().optional().describe("Scene path for open_scene / play_scene."),
        node: z.string().optional().describe("Node path for select."),
      },
    },
    guard(
      async ({
        project,
        action,
        scene,
        node,
      }: {
        project?: string;
        action: string;
        scene?: string;
        node?: string;
      }) => {
        const root = ctx.project(project);

        if (action === "launch") {
          ctx.assertWritable("editor_control");
          const existing = getSession(root, "editor");
          if (isRunning(existing)) {
            return text("The editor is already running (started by this server).");
          }
          const info = loadProject(root);
          await launch({
            projectRoot: root,
            kind: "editor",
            args: ["--editor", "--path", root],
            target: info.name,
            headless: false,
            replace: true,
          });
          return text(
            joinSections(
              `Launched the Godot editor for "${info.name}".`,
              bridgeStatus(root, "editor").available || existsSync(path.join(root, ADDON_SUBDIR, "plugin.cfg"))
                ? "The live bridge should connect within a few seconds; check with godot_status."
                : "Run bridge_install to enable live editor and runtime features.",
            ),
          );
        }

        ctx.assertWritable("editor_control");

        const params: Record<string, unknown> = {};
        let command = action;
        if (action === "open_scene" || action === "play_scene") {
          if (!scene) throw new GodotAssistantError(`${action} needs \`scene\`.`);
          params["path"] = toResPath(scene, root);
        }
        if (action === "select") {
          if (!node) throw new GodotAssistantError("select needs `node`.");
          params["node"] = node;
        }
        if (action === "state") command = "state";

        const response = await requireBridge(root, "editor", command, params);
        const { ok: _ok, id: _id, ...detail } = response;
        return text(
          Object.entries(detail)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.length ? v.join("\n  ") : "(none)") : v}`)
            .join("\n"),
        );
      },
    ),
  );
}

function projectFile(root: string): string {
  return path.join(root, "project.godot");
}

const AUTOLOAD_NAME = "GodotAssistantRuntime";
const AUTOLOAD_PATH = "*res://addons/godot_assistant/runtime_autoload.gd";

/**
 * Registers the runtime autoload directly in project.godot.
 *
 * Doing this here rather than from the editor plugin is what makes the runtime
 * bridge work for a game launched straight from the command line — the common
 * case for an agent, which never opens the editor at all.
 */
export function setRuntimeAutoload(root: string, enabled: boolean): void {
  const file = projectFile(root);
  let content = readFileSync(file, "utf8");
  const entryRe = new RegExp(`^\\s*${AUTOLOAD_NAME}\\s*=.*$\\n?`, "m");
  const present = entryRe.test(content);

  if (enabled) {
    if (present) return;
    const entry = `${AUTOLOAD_NAME}="${AUTOLOAD_PATH}"`;
    if (/^\[autoload\]/m.test(content)) {
      content = content.replace(/^\[autoload\]\s*\n/m, `[autoload]\n\n${entry}\n`);
    } else {
      content = `${content.trimEnd()}\n\n[autoload]\n\n${entry}\n`;
    }
  } else {
    if (!present) return;
    content = content.replace(entryRe, "");
    // Drop the section header if we just removed its only entry.
    content = content.replace(/^\[autoload\]\s*\n(?=\s*(\[|$))/m, "");
  }

  writeFileSync(file, content, "utf8");
}

export function isPluginEnabled(root: string): boolean {
  try {
    const content = readFileSync(projectFile(root), "utf8");
    const match = /^\s*enabled\s*=\s*(PackedStringArray\([^)]*\))/m.exec(content);
    if (!match) return false;
    return parseStringArray(match[1] ?? "").includes(PLUGIN_ENTRY);
  } catch {
    return false;
  }
}

/**
 * Adds or removes our plugin from the `[editor_plugins] enabled` list.
 *
 * The file is edited textually rather than reserialised from a parse, so every
 * comment, ordering choice and setting we do not understand survives untouched.
 * project.godot is a file users hand-edit and keep in version control; silently
 * reformatting it would be hostile.
 */
export function setPluginEnabled(root: string, enabled: boolean): void {
  const file = projectFile(root);
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    throw new GodotAssistantError(`Cannot read ${file}`);
  }

  const enabledRe = /^(\s*enabled\s*=\s*)(PackedStringArray\([^)]*\))/m;
  const match = enabledRe.exec(content);
  const current = match ? parseStringArray(match[2] ?? "") : [];
  const next = enabled
    ? current.includes(PLUGIN_ENTRY)
      ? current
      : [...current, PLUGIN_ENTRY]
    : current.filter((entry) => entry !== PLUGIN_ENTRY);

  if (match && next.length === current.length && enabled === current.includes(PLUGIN_ENTRY)) {
    return; // already in the desired state
  }

  const serialised = `PackedStringArray(${next.map((entry) => `"${entry}"`).join(", ")})`;

  if (match) {
    content = content.replace(enabledRe, `$1${serialised}`);
  } else if (enabled) {
    if (/^\[editor_plugins\]/m.test(content)) {
      content = content.replace(/^\[editor_plugins\]/m, `[editor_plugins]\n\nenabled=${serialised}`);
    } else {
      content = `${content.trimEnd()}\n\n[editor_plugins]\n\nenabled=${serialised}\n`;
    }
  } else {
    return;
  }

  writeFileSync(file, content, "utf8");
}
