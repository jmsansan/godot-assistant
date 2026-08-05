/**
 * Project discovery, status and search tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operation } from "../godot/cli.js";
import { locateGodot } from "../godot/locate.js";
import { bridgeStatus } from "../godot/bridge.js";
import { findProjectRoot, loadProject } from "../godot/project.js";
import { listSessions } from "../godot/process.js";
import { joinSections, kv, paginate, section, table } from "../util/text.js";
import { guard, projectParam, text, type ToolContext } from "./common.js";

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "godot_status",
    {
      title: "Godot status",
      description:
        "Environment and project health check: Godot version, project detection, live bridge state, running processes. Start here when anything is unexpected, or to confirm setup.",
      inputSchema: { project: projectParam },
    },
    guard(async ({ project }: { project?: string }) => {
      const lines: string[] = [];

      let godotLine: string;
      try {
        const binary = await locateGodot(process.env["GODOT_PATH"]);
        godotLine = kv([
          ["engine", `Godot ${binary.version}`],
          ["binary", binary.path],
          ["found via", binary.source],
          ["C# support", binary.dotnet ? "yes (.NET build)" : "no (standard build)"],
        ]);
      } catch (error) {
        godotLine = (error as Error).message;
      }
      lines.push(section("Engine", godotLine));

      let root: string | null = null;
      try {
        root = ctx.project(project);
      } catch {
        root = project ? findProjectRoot(project) : null;
      }

      if (!root) {
        lines.push(
          section(
            "Project",
            "No project resolved.\nPass `project` with the folder containing project.godot, or start the server with --project.",
          ),
        );
        return text(joinSections(...lines));
      }

      const info = loadProject(root);
      lines.push(
        section(
          "Project",
          kv([
            ["name", info.name],
            ["path", info.root],
            ["main scene", info.mainScene ?? "(not set)"],
            ["renderer", info.renderingMethod ?? "(default)"],
            ["features", info.features.join(", ")],
            ["language", info.dotnet ? "C# (.NET)" : "GDScript"],
          ]),
        ),
      );

      if (info.dotnet) {
        const binary = await locateGodot(process.env["GODOT_PATH"]).catch(() => null);
        if (binary && !binary.dotnet) {
          lines.push(
            section(
              "Warning",
              "This is a C# project but the configured Godot is not a .NET build.\nScene edits that touch C# scripts are refused to avoid dropping script attachments.\nFix: install the .NET build of Godot 4 and set GODOT_PATH to it.",
            ),
          );
        }
      }

      const editor = bridgeStatus(root, "editor");
      const runtime = bridgeStatus(root, "runtime");
      lines.push(
        section(
          "Live bridge (optional)",
          kv([
            ["editor", editor.available ? `connected (pid ${editor.discovery?.pid})` : `not available — ${editor.reason}`],
            ["running game", runtime.available ? `connected (pid ${runtime.discovery?.pid})` : `not available — ${runtime.reason}`],
          ]) +
            (editor.available
              ? ""
              : "\n\nEverything except live inspection, input simulation and editor screenshots works without it. Run `bridge_install` to enable those."),
        ),
      );

      const active = listSessions().filter((s) => s.projectRoot === root);
      if (active.length) {
        lines.push(
          section(
            "Processes started by this server",
            table(
              active.map((s) => [
                s.kind,
                s.exitedAt === undefined ? "running" : `exited (${s.exitCode})`,
                s.target ?? "-",
                `${Math.round((Date.now() - s.startedAt) / 1000)}s`,
              ]),
              ["kind", "state", "target", "age"],
            ),
          ),
        );
      }

      return text(joinSections(...lines));
    }),
  );

  server.registerTool(
    "project_info",
    {
      title: "Project info",
      description:
        "Project settings that matter for writing code: main scene, autoload singletons, input actions, physics layers, file counts. Read this before generating gameplay code.",
      inputSchema: {
        project: projectParam,
        include: z
          .array(z.enum(["autoloads", "input", "layers", "counts", "settings"]))
          .optional()
          .describe("Sections to include. Default: all except raw settings."),
      },
    },
    guard(async ({ project, include }: { project?: string; include?: string[] }) => {
      const root = ctx.project(project);
      const info = loadProject(root);
      const want = (name: string) => !include || include.includes(name);
      const parts: string[] = [];

      parts.push(
        section(
          "Project",
          kv([
            ["name", info.name],
            ["path", info.root],
            ["main scene", info.mainScene ?? "(not set)"],
            ["renderer", info.renderingMethod ?? "forward_plus (default)"],
            ["language", info.dotnet ? "C# (.NET)" : "GDScript"],
          ]),
        ),
      );

      if (want("autoloads")) {
        const rows = Object.entries(info.autoloads).map(([name, path]) => [
          name,
          path.replace(/^\*/, ""),
          path.startsWith("*") ? "singleton" : "",
        ]);
        parts.push(
          section(
            "Autoloads",
            rows.length
              ? table(rows, ["name", "path", "mode"]) +
                  "\n\nThese are globally accessible by name from any script."
              : "(none)",
          ),
        );
      }

      if (want("input")) {
        const rows = Object.entries(info.inputActions).map(([name, events]) => [name, events]);
        parts.push(
          section(
            "Input actions",
            rows.length
              ? table(rows, ["action", "bound to"]) +
                  '\n\nUse these exact names with Input.is_action_pressed("name").'
              : "(none defined — only Godot's built-in ui_* actions are available)",
          ),
        );
      }

      if (want("layers")) {
        const layers = Object.entries(info.raw["layer_names"] ?? {})
          .map(([key, value]) => [key.replace(/^\w+\//, ""), value.replace(/^"|"$/g, "")])
          .filter(([, v]) => v);
        parts.push(
          section("Named layers", layers.length ? table(layers, ["layer", "name"]) : "(none named)"),
        );
      }

      if (want("counts")) {
        const stats = await operation("project_stats", {}, root);
        const counts = (stats["counts"] ?? {}) as Record<string, number>;
        parts.push(
          section(
            "Contents",
            table(
              Object.entries(counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => [k, String(n)]),
              ["kind", "files"],
            ),
          ),
        );
      }

      if (include?.includes("settings")) {
        const flat: string[][] = [];
        for (const [sectionName, entries] of Object.entries(info.raw)) {
          for (const [key, value] of Object.entries(entries)) {
            flat.push([`${sectionName}/${key}`, value.slice(0, 120)]);
          }
        }
        parts.push(section("Raw settings", table(flat)));
      }

      return text(joinSections(...parts));
    }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List project files",
      description:
        "List project files by kind (scenes, scripts, resources, images, audio, models) with optional glob. Use to orient in an unfamiliar project.",
      inputSchema: {
        project: projectParam,
        kind: z
          .enum(["all", "scenes", "scripts", "resources", "images", "audio", "models"])
          .default("all")
          .describe("Filter by file kind."),
        pattern: z.string().optional().describe('Glob against name or full path, e.g. "*enemy*".'),
        dir: z.string().optional().describe('Limit to a subfolder, e.g. "res://levels".'),
        offset: z.number().int().min(0).default(0).describe("Pagination offset."),
        limit: z.number().int().min(1).max(1000).default(200).describe("Max entries to return."),
      },
    },
    guard(
      async ({
        project,
        kind,
        pattern,
        dir,
        offset,
        limit,
      }: {
        project?: string;
        kind: string;
        pattern?: string;
        dir?: string;
        offset: number;
        limit: number;
      }) => {
        const root = ctx.project(project);
        const result = await operation(
          "list_files",
          { kind, pattern: pattern ?? "", dir: dir ?? "res://" },
          root,
        );
        const files = (result["files"] ?? []) as string[];
        return text(paginate(files, offset, limit, (f) => f));
      },
    ),
  );

  server.registerTool(
    "search",
    {
      title: "Search project",
      description:
        "Grep across scripts, scenes and resources. Finds symbol definitions, node types used in scenes, signal names, TODOs. Returns file:line with the matching line.",
      inputSchema: {
        project: projectParam,
        query: z.string().describe("Literal text to find (not a regex)."),
        kind: z
          .enum(["all", "scripts", "scenes", "resources"])
          .default("all")
          .describe("Restrict which file kinds are searched."),
        case_sensitive: z.boolean().default(false),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    guard(
      async ({
        project,
        query,
        kind,
        case_sensitive,
        offset,
        limit,
      }: {
        project?: string;
        query: string;
        kind: string;
        case_sensitive: boolean;
        offset: number;
        limit: number;
      }) => {
        const root = ctx.project(project);
        const result = await operation(
          "search",
          { query, kind, case_sensitive, max_results: 1000 },
          root,
        );
        const hits = (result["hits"] ?? []) as Array<{ file: string; line: number; text: string }>;
        if (hits.length === 0) return text(`No matches for "${query}".`);
        return text(
          paginate(hits, offset, limit, (h) => `${h.file}:${h.line}: ${h.text}`),
        );
      },
    ),
  );
}
