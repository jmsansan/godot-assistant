/**
 * Script authoring and validation tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runOperation } from "../godot/cli.js";
import { formatDiagnostics } from "../util/errors.js";
import { assertNodePath, toResPath } from "../util/paths.js";
import { joinSections, pluralize, section } from "../util/text.js";
import { guard, projectParam, text, type ToolContext } from "./common.js";

export function registerScriptTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "script_create",
    {
      title: "Create script",
      description:
        "Write a new GDScript file, optionally attaching it to a node in a scene in the same step. Provide `content` for real code; omit it for a stub.",
      inputSchema: {
        project: projectParam,
        path: z.string().describe('Script path, e.g. "res://player/player.gd".'),
        content: z.string().optional().describe("Full file contents. Omit for a minimal stub."),
        extends: z
          .string()
          .default("Node")
          .describe("Base class for the generated stub. Ignored when content is given."),
        class_name: z.string().optional().describe("Optional global class_name for the stub."),
        attach_to_scene: z.string().optional().describe("Scene to attach the new script to."),
        attach_to_node: z.string().default(".").describe("Node within that scene."),
        overwrite: z.boolean().default(false),
      },
    },
    guard(
      async (args: {
        project?: string;
        path: string;
        content?: string;
        extends: string;
        class_name?: string;
        attach_to_scene?: string;
        attach_to_node: string;
        overwrite: boolean;
      }) => {
        ctx.assertWritable("script_create");
        const root = ctx.project(args.project);
        const scriptPath = toResPath(args.path, root);

        const { result } = await runOperation(
          "script_create",
          {
            path: scriptPath,
            content: args.content ?? "",
            extends: args.extends,
            class_name: args.class_name ?? "",
            attach_to_scene: args.attach_to_scene ? toResPath(args.attach_to_scene, root) : "",
            attach_to_node: assertNodePath(args.attach_to_node),
            overwrite: args.overwrite,
          },
          root,
        );
        if (!result.ok) {
          return text(`${result.error}${result.hint ? `\n\nFix: ${result.hint}` : ""}`);
        }

        // Creating a script that does not compile is a silent trap; check now
        // rather than letting it surface later as a scene that will not load.
        const check = await runOperation("validate_scripts", { path: scriptPath }, root);
        const failed = (check.result["failed"] ?? []) as string[];
        const errors = check.raw.diagnostics.filter((d) => d.severity !== "warning");

        return text(
          joinSections(
            `Created ${result["path"]}`,
            result["attached_to"] ? `Attached to ${result["attached_to"]}` : "",
            failed.length
              ? section(
                  "This script does not compile",
                  `${formatDiagnostics(errors)}\n\nThe file was written, but fix these before using it.`,
                )
              : "",
          ),
        );
      },
    ),
  );

  server.registerTool(
    "script_validate",
    {
      title: "Validate scripts",
      description:
        "Parse-check GDScript — one file or the whole project — and report errors with file and line. Run this after editing scripts and before running the game; it is much faster than launching.",
      inputSchema: {
        project: projectParam,
        path: z.string().optional().describe("Single script to check. Omit to check every .gd in the project."),
      },
    },
    guard(async ({ project, path }: { project?: string; path?: string }) => {
      const root = ctx.project(project);
      const { result, raw } = await runOperation(
        "validate_scripts",
        { path: path ? toResPath(path, root) : "" },
        root,
        { timeoutMs: 180_000 },
      );

      const failed = (result["failed"] ?? []) as string[];
      const checked = Number(result["checked"] ?? 0);
      const errors = raw.diagnostics.filter((d) => d.severity !== "warning");

      if (failed.length === 0) {
        return text(`${pluralize(checked, "script")} checked, no parse errors.`);
      }

      return text(
        joinSections(
          `${failed.length} of ${checked} scripts failed to compile.`,
          section("Errors", formatDiagnostics(errors) || failed.map((f) => `ERROR [${f}] failed to load`).join("\n")),
          section("Affected files", failed.join("\n")),
        ),
      );
    }),
  );
}
