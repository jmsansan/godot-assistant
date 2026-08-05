/**
 * Resource (.tres) and asset-import tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operation } from "../godot/cli.js";
import { bridgeStatus, sendCommand } from "../godot/bridge.js";
import { assertClassName, toResPath } from "../util/paths.js";
import { joinSections, paginate, pluralize, section, table } from "../util/text.js";
import { guard, projectParam, text, type ToolContext } from "./common.js";

export function registerResourceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "resource_manage",
    {
      title: "Manage resources",
      description:
        "Create, read or edit Godot resource files (.tres): materials, themes, curves, tilesets, physics shapes, input/animation data. Use api_reference first to find the right class and property names.",
      inputSchema: {
        project: projectParam,
        action: z.enum(["create", "read", "edit"]),
        path: z.string().describe('Resource path, e.g. "res://materials/water.tres".'),
        type: z
          .string()
          .optional()
          .describe("Resource class for create, e.g. StandardMaterial3D, Theme, CircleShape2D."),
        properties: z
          .record(z.any())
          .optional()
          .describe("Property values. Same JSON conversions as node properties."),
        overwrite: z.boolean().default(false),
      },
    },
    guard(
      async (args: {
        project?: string;
        action: string;
        path: string;
        type?: string;
        properties?: Record<string, unknown>;
        overwrite: boolean;
      }) => {
        const root = ctx.project(args.project);
        const resourcePath = toResPath(args.path, root);

        if (args.action === "read") {
          const result = await operation("resource_read", { path: resourcePath }, root);
          const props = (result["properties"] ?? []) as Array<{ name: string; type: string; value: string }>;
          return text(
            joinSections(
              `${result["path"]} (${result["type"]})`,
              table(props.map((p) => [p.name, p.value, p.type]), ["property", "value", "type"]),
            ),
          );
        }

        ctx.assertWritable("resource_manage");

        if (args.action === "create") {
          if (!args.type) {
            return text('create needs `type`, e.g. type="StandardMaterial3D". Use api_reference to find it.');
          }
          const result = await operation(
            "resource_create",
            {
              path: resourcePath,
              type: assertClassName(args.type, "type"),
              properties: args.properties ?? {},
              overwrite: args.overwrite,
            },
            root,
          );
          return text(`Created ${result["path"]} (${result["type"]}).`);
        }

        const result = await operation(
          "resource_edit",
          { path: resourcePath, properties: args.properties ?? {} },
          root,
        );
        const changed = (result["changed"] ?? []) as string[];
        return text(`Updated ${result["path"]}: ${changed.join(", ")}`);
      },
    ),
  );

  server.registerTool(
    "import_assets",
    {
      title: "Import assets",
      description:
        'Find and fix assets Godot has not imported yet. New image or audio files are unusable until imported — that is the cause of "No loader found for resource". Call this after adding files outside the editor.',
      inputSchema: {
        project: projectParam,
        action: z
          .enum(["check", "reimport"])
          .default("check")
          .describe("'check' lists unimported files; 'reimport' triggers an import pass."),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    guard(
      async ({
        project,
        action,
        offset,
        limit,
      }: {
        project?: string;
        action: string;
        offset: number;
        limit: number;
      }) => {
        const root = ctx.project(project);
        const status = await operation("import_status", {}, root, { timeoutMs: 120_000 });
        const missing = (status["unimported"] ?? []) as string[];

        if (action === "check") {
          if (missing.length === 0) {
            return text(`All ${status["checked"]} files are imported.`);
          }
          return text(
            joinSections(
              `${pluralize(missing.length, "file")} not imported yet:`,
              paginate(missing, offset, limit, (f) => f),
              "Run again with action='reimport' to import them.",
            ),
          );
        }

        ctx.assertWritable("import_assets");

        // A running editor imports far faster and updates its own filesystem
        // dock; fall back to a headless import pass when it is not available.
        const editor = bridgeStatus(root, "editor");
        if (editor.available && editor.discovery) {
          await sendCommand(editor.discovery, "reimport", { files: missing }, 120_000);
          await sendCommand(editor.discovery, "rescan", {}, 60_000);
          return text(
            `Asked the running editor to import ${pluralize(missing.length, "file")}. Re-run with action='check' to confirm.`,
          );
        }

        // Opening the project headless with --import runs the import pipeline
        // and exits; this is the supported way to do it without the editor.
        const { runGodot } = await import("../godot/cli.js");
        const result = await runGodot(["--headless", "--path", root, "--import"], {
          cwd: root,
          timeoutMs: 300_000,
        });
        if (result.timedOut) {
          return text("Import timed out after 5 minutes. Large projects may need to be imported by opening them in the editor once.");
        }
        const after = await operation("import_status", {}, root, { timeoutMs: 120_000 });
        const remaining = (after["unimported"] ?? []) as string[];
        return text(
          joinSections(
            `Import pass complete. ${missing.length - remaining.length} of ${missing.length} files imported.`,
            remaining.length
              ? section(
                  "Still unimported",
                  `${remaining.slice(0, 40).join("\n")}\n\nThese are usually corrupt or in an unsupported format.`,
                )
              : "",
          ),
        );
      },
    ),
  );

  server.registerTool(
    "export_project",
    {
      title: "Export project",
      description:
        "List export presets, or build one. Presets must first be created in the Godot editor under Project > Export.",
      inputSchema: {
        project: projectParam,
        action: z.enum(["list", "export"]).default("list"),
        preset: z.string().optional().describe("Preset name, exactly as shown by action='list'."),
        output: z.string().optional().describe("Output file path. Defaults to the preset's own path."),
        debug: z.boolean().default(false).describe("Build a debug binary rather than a release one."),
      },
    },
    guard(
      async (args: {
        project?: string;
        action: string;
        preset?: string;
        output?: string;
        debug: boolean;
      }) => {
        const root = ctx.project(args.project);

        if (args.action === "list") {
          const result = await operation("export_presets", {}, root);
          const presets = (result["presets"] ?? []) as Array<{ name: string; platform: string; export_path: string }>;
          if (presets.length === 0) {
            return text(String(result["note"] ?? "No export presets are defined."));
          }
          return text(
            table(presets.map((p) => [p.name, p.platform, p.export_path || "(no path set)"]), [
              "preset",
              "platform",
              "output",
            ]),
          );
        }

        ctx.assertWritable("export_project");
        if (!args.preset) {
          return text("export needs `preset`. Run action='list' to see the available presets.");
        }

        const { runGodot } = await import("../godot/cli.js");
        const flag = args.debug ? "--export-debug" : "--export-release";
        const argv = ["--headless", "--path", root, flag, args.preset];
        if (args.output) argv.push(args.output);

        const result = await runGodot(argv, { cwd: root, timeoutMs: 600_000 });
        if (result.timedOut) return text("Export timed out after 10 minutes.");

        const errors = result.diagnostics.filter((d) => d.severity !== "warning");
        if (result.code !== 0 || errors.length) {
          return text(
            joinSections(
              `Export failed (exit ${result.code}).`,
              section("Errors", errors.map((d) => d.message).join("\n") || result.stderr.slice(-2000)),
              "Export templates for the target platform must be installed — see Editor > Manage Export Templates.",
            ),
          );
        }
        return text(`Exported preset "${args.preset}"${args.output ? ` to ${args.output}` : ""}.`);
      },
    ),
  );
}
