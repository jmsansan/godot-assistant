/**
 * Running the project and reading what it printed.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GodotAssistantError, formatDiagnostics } from "../util/errors.js";
import { toResPath } from "../util/paths.js";
import { joinSections, kv, paginate, pluralize, section } from "../util/text.js";
import { clearOutput, getSession, isRunning, launch, readOutput, stop } from "../godot/process.js";
import { loadProject } from "../godot/project.js";
import { guard, projectParam, text, type ToolContext } from "./common.js";

export function registerRunTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "run_project",
    {
      title: "Run project",
      description:
        "Launch the game and capture its output. Runs the main scene, or one specific scene. Use wait_seconds for a quick check that returns the log; omit it to leave the game running and poll with get_output.",
      inputSchema: {
        project: projectParam,
        scene: z.string().optional().describe("Run just this scene (like F6). Omit for the main scene."),
        headless: z
          .boolean()
          .default(false)
          .describe("Run with no window. Faster and CI-safe, but nothing renders — screenshots will not work."),
        wait_seconds: z
          .number()
          .min(0)
          .max(120)
          .default(0)
          .describe("Run for this long, stop, and return the output. 0 leaves it running in the background."),
        args: z.array(z.string()).optional().describe("Extra arguments passed to the game after --."),
        replace: z.boolean().default(true).describe("Restart if something is already running."),
        always_on_top: z
          .boolean()
          .default(true)
          .describe(
            "Keep the game window above others. Default on: an occluded window is throttled by the OS and stops drawing, which makes screenshot(source='game') return stale frames or time out.",
          ),
      },
    },
    guard(
      async (params: {
        project?: string;
        scene?: string;
        headless: boolean;
        wait_seconds: number;
        args?: string[];
        replace: boolean;
        always_on_top: boolean;
      }) => {
        ctx.assertWritable("run_project");
        const root = ctx.project(params.project);
        const info = loadProject(root);

        const godotArgs: string[] = ["--path", root];
        if (params.headless) godotArgs.push("--headless");
        else if (params.always_on_top) godotArgs.push("--always-on-top");

        let target: string | undefined;
        if (params.scene) {
          target = toResPath(params.scene, root);
          godotArgs.push(target);
        } else if (!info.mainScene) {
          throw new GodotAssistantError(
            "This project has no main scene set, so there is nothing to run.",
            'Pass `scene` to run one specific scene, or set the main scene in Project Settings ("application/run/main_scene").',
          );
        } else {
          target = info.mainScene;
        }

        if (params.args?.length) godotArgs.push("--", ...params.args);

        const session = await launch({
          projectRoot: root,
          kind: params.scene ? "scene" : "project",
          args: godotArgs,
          target,
          headless: params.headless,
          replace: params.replace,
        });

        if (params.wait_seconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, params.wait_seconds * 1000));
          await stop(root, session.kind);
          const view = readOutput(session);
          return text(
            joinSections(
              `Ran ${target} for ${params.wait_seconds}s, then stopped.`,
              renderOutput(view),
            ),
          );
        }

        const view = readOutput(session);
        const early = view.diagnostics.filter((d) => d.severity !== "warning");
        return text(
          joinSections(
            `Running ${target}${params.headless ? " (headless)" : ""}.`,
            early.length ? section("Errors already reported", formatDiagnostics(early)) : "",
            "Use get_output to read the log, screenshot to see it, stop_project when finished.",
          ),
        );
      },
    ),
  );

  server.registerTool(
    "get_output",
    {
      title: "Get run output",
      description:
        "Read console output from the running (or last) session. Errors and warnings are parsed, deduplicated and shown with file:line; repeated per-frame errors are collapsed.",
      inputSchema: {
        project: projectParam,
        severity: z
          .enum(["all", "errors", "warnings", "print"])
          .default("all")
          .describe('"errors" hides warnings and normal output; "print" shows only the game\'s own prints.'),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(120),
        clear: z.boolean().default(false).describe("Empty the buffer after reading."),
      },
    },
    guard(
      async ({
        project,
        severity,
        offset,
        limit,
        clear,
      }: {
        project?: string;
        severity: string;
        offset: number;
        limit: number;
        clear: boolean;
      }) => {
        const root = ctx.project(project);
        const session =
          getSession(root, "project") ?? getSession(root, "scene") ?? getSession(root, "editor");
        if (!session) {
          return text("Nothing has been run for this project yet. Start it with run_project.");
        }

        const view = readOutput(session);
        const parts: string[] = [
          kv([
            ["target", session.target ?? session.kind],
            ["state", view.running ? "running" : `exited with code ${view.exitCode}`],
            ["runtime", `${(view.runtimeMs / 1000).toFixed(1)}s`],
            ...(view.dropped > 0
              ? ([["note", `${view.dropped} older lines dropped from the buffer`]] as Array<[string, string]>)
              : []),
          ]),
        ];

        if (severity !== "print") {
          const wanted = view.diagnostics.filter((d) =>
            severity === "errors" ? d.severity !== "warning" : severity === "warnings" ? d.severity === "warning" : true,
          );
          parts.push(
            section(
              "Diagnostics",
              wanted.length
                ? paginate(wanted, offset, limit, (d) =>
                    formatDiagnostics([d], true),
                  )
                : "(none)",
            ),
          );
        }

        if (severity === "all" || severity === "print") {
          parts.push(
            section(
              "Output",
              view.output.length ? paginate(view.output, offset, limit, (l) => l) : "(none)",
            ),
          );
        }

        if (clear) clearOutput(session);
        return text(joinSections(...parts));
      },
    ),
  );

  server.registerTool(
    "stop_project",
    {
      title: "Stop project",
      description: "Stop the running game or editor started by this server, and return the final output summary.",
      inputSchema: {
        project: projectParam,
        what: z.enum(["game", "editor", "all"]).default("game"),
      },
    },
    guard(async ({ project, what }: { project?: string; what: string }) => {
      const root = ctx.project(project);
      const kinds = what === "all" ? (["project", "scene", "editor"] as const) : what === "editor" ? (["editor"] as const) : (["project", "scene"] as const);

      const stopped: string[] = [];
      for (const kind of kinds) {
        const session = getSession(root, kind);
        if (!isRunning(session)) continue;
        await stop(root, kind);
        const view = readOutput(session);
        const errors = view.diagnostics.filter((d) => d.severity !== "warning");
        stopped.push(
          `${kind} (${session.target ?? "-"}) — ran ${(view.runtimeMs / 1000).toFixed(1)}s, ${pluralize(errors.length, "error")}`,
        );
      }

      if (stopped.length === 0) return text("Nothing was running for this project.");
      return text(`Stopped:\n${stopped.map((s) => `- ${s}`).join("\n")}`);
    }),
  );
}

function renderOutput(view: ReturnType<typeof readOutput>): string {
  const errors = view.diagnostics.filter((d) => d.severity !== "warning");
  const warnings = view.diagnostics.filter((d) => d.severity === "warning");
  return joinSections(
    kv([
      ["exit code", String(view.exitCode ?? "n/a")],
      ["errors", String(errors.length)],
      ["warnings", String(warnings.length)],
    ]),
    errors.length ? section("Errors", formatDiagnostics(errors, true)) : "",
    warnings.length ? section("Warnings", formatDiagnostics(warnings.slice(0, 20))) : "",
    view.output.length ? section("Output", view.output.slice(-80).join("\n")) : "",
  );
}
