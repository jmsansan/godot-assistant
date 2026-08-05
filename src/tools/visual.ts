/**
 * Visual verification and input simulation.
 *
 * Most mistakes in game code are visual, not fatal: a sprite anchored wrong, a
 * UI element off-screen, a shader that renders black. None of that reaches the
 * console, so an agent limited to logs cannot tell a working scene from a broken
 * one. These tools close that loop.
 */

import { readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CAPTURE_SCRIPT, runGodot } from "../godot/cli.js";
import { requireBridge } from "../godot/bridge.js";
import { GodotAssistantError } from "../util/errors.js";
import { toResPath } from "../util/paths.js";
import { getSession, isRunning } from "../godot/process.js";
import { loadProject } from "../godot/project.js";
import { guard, image, projectParam, text, type ToolContext } from "./common.js";

const BEGIN = "<<<GODOT_ASSISTANT_RESULT";
const END = "GODOT_ASSISTANT_RESULT>>>";

export function registerVisualTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "See what a scene actually looks like. `scene` renders any scene offscreen with no setup. `game` captures the running game and `editor` captures the Godot editor (both need bridge_install). Use this to verify layout and visuals — the console cannot show them.",
      inputSchema: {
        project: projectParam,
        source: z
          .enum(["scene", "game", "editor"])
          .default("scene")
          .describe("What to capture. 'scene' works with no setup."),
        scene: z.string().optional().describe("Scene to render when source=scene. Defaults to the main scene."),
        width: z.number().int().min(64).max(3840).default(960),
        height: z.number().int().min(64).max(2160).default(540),
        frames: z
          .number()
          .int()
          .min(1)
          .max(600)
          .default(6)
          .describe("Frames to render before capturing. Raise it for animations or anything that settles over time."),
        background: z
          .string()
          .optional()
          .describe('Backdrop colour behind the scene, e.g. "#101018". Helps when sprites have transparency.'),
      },
    },
    guard(
      async (args: {
        project?: string;
        source: string;
        scene?: string;
        width: number;
        height: number;
        frames: number;
        background?: string;
      }) => {
        const root = ctx.project(args.project);
        const dir = mkdtempSync(path.join(tmpdir(), "godot-assistant-"));
        const outFile = path.join(dir, "capture.png");

        try {
          if (args.source === "game") {
            const session = getSession(root, "project") ?? getSession(root, "scene");
            if (session && isRunning(session) && session.headless) {
              throw new GodotAssistantError(
                "The game is running headless, so there is nothing rendered to capture.",
                "Restart it with run_project headless=false.",
              );
            }
            await requireBridge(root, "runtime", "screenshot", { out: outFile }, 30_000);
          } else if (args.source === "editor") {
            await requireBridge(root, "editor", "screenshot", { out: outFile }, 30_000);
          } else {
            await renderScene(root, args, outFile);
          }

          const png = readFileSync(outFile);
          const label =
            args.source === "scene"
              ? `${args.scene ?? loadProject(root).mainScene ?? "main scene"} rendered at ${args.width}x${args.height}`
              : args.source === "game"
                ? "Running game"
                : "Godot editor";
          return image(png.toString("base64"), "image/png", label);
        } finally {
          try {
            unlinkSync(outFile);
          } catch {
            /* best effort */
          }
        }
      },
    ),
  );

  server.registerTool(
    "simulate_input",
    {
      title: "Simulate input",
      description:
        "Send synthetic input to the running game — a mapped action, a key, a mouse move or a click. Goes through Godot's input system, so the game reacts exactly as it would to a real device. Requires bridge_install and a running game.",
      inputSchema: {
        project: projectParam,
        kind: z
          .enum(["action", "key", "click", "mouse_button", "mouse_move"])
          .describe("Prefer 'action' — it uses the project's own input map and survives rebinding."),
        action: z.string().optional().describe('Input action name, e.g. "ui_accept", "jump".'),
        key: z.string().optional().describe('Key name, e.g. "A", "Space", "Escape", "Left", "F1".'),
        pressed: z.boolean().default(true).describe("Press (true) or release (false). 'click' always does both."),
        strength: z.number().min(0).max(1).default(1).describe("Analog strength for actions."),
        x: z.number().optional().describe("Screen X for mouse events."),
        y: z.number().optional().describe("Screen Y for mouse events."),
        button: z.number().int().min(1).max(9).default(1).describe("1 left, 2 right, 3 middle."),
        shift: z.boolean().default(false),
        ctrl: z.boolean().default(false),
        alt: z.boolean().default(false),
      },
    },
    guard(async (args: Record<string, unknown>) => {
      ctx.assertWritable("simulate_input");
      const root = ctx.project(args["project"] as string | undefined);
      const { project: _ignored, ...params } = args;
      const response = await requireBridge(root, "runtime", "input", params);
      const { ok: _ok, id: _id, ...detail } = response;
      return text(
        `Input sent.\n${Object.entries(detail)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join("\n")}\n\nCapture the result with screenshot(source="game").`,
      );
    }),
  );

  server.registerTool(
    "runtime_inspect",
    {
      title: "Inspect running game",
      description:
        "Read the live state of the running game: actual node tree with world positions and visibility, real property values, FPS and node counts. Shows what is true at runtime, which often differs from the scene file. Requires bridge_install.",
      inputSchema: {
        project: projectParam,
        what: z
          .enum(["state", "tree", "node"])
          .default("state")
          .describe("'state' for a summary, 'tree' for the live hierarchy, 'node' for one node's properties."),
        node: z.string().default(".").describe("Node path for what='node', relative to the current scene."),
        properties: z.array(z.string()).optional().describe("Limit to these property names."),
        max_depth: z.number().int().min(1).max(20).default(5),
      },
    },
    guard(
      async (args: {
        project?: string;
        what: string;
        node: string;
        properties?: string[];
        max_depth: number;
      }) => {
        const root = ctx.project(args.project);
        const command = args.what === "state" ? "state" : args.what === "tree" ? "tree" : "inspect";
        const response = await requireBridge(root, "runtime", command, {
          node: args.node,
          max_depth: args.max_depth,
          properties: args.properties ?? [],
        });

        if (args.what === "tree") {
          return text(renderLiveTree(response["tree"] as LiveNode).join("\n"));
        }
        if (args.what === "node") {
          const props = (response["properties"] ?? []) as Array<{ name: string; value: string }>;
          return text(
            [
              `${args.node} (${response["type"]})`,
              `groups: ${(response["groups"] as string[])?.join(", ") || "(none)"}`,
              "",
              ...props.map((p) => `${p.name} = ${p.value}`),
            ].join("\n"),
          );
        }
        const { ok: _ok, id: _id, ...state } = response;
        return text(
          Object.entries(state)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("x") : v}`)
            .join("\n"),
        );
      },
    ),
  );
}

interface LiveNode {
  name: string;
  type: string;
  pos?: number[];
  rect?: number[];
  visible?: boolean;
  text?: string;
  children?: LiveNode[];
  truncated_children?: number;
}

function renderLiveTree(node: LiveNode, depth = 0, out: string[] = []): string[] {
  const pad = "  ".repeat(depth);
  const bits = [`${pad}${node.name}`, `(${node.type})`];
  if (node.pos) bits.push(`at ${node.pos.join(",")}`);
  if (node.rect) bits.push(`rect ${node.rect.join(",")}`);
  if (node.visible === false) bits.push("HIDDEN");
  if (node.text) bits.push(`text "${node.text}"`);
  out.push(bits.join(" "));
  for (const child of node.children ?? []) renderLiveTree(child, depth + 1, out);
  if (node.truncated_children) out.push(`${pad}  … ${node.truncated_children} more (raise max_depth)`);
  return out;
}

/**
 * Renders a scene offscreen with no project changes and no addon.
 *
 * `--headless` is deliberately absent: it disables the rendering server, and
 * waiting for a drawn frame under it never returns. The window is positioned
 * far off-screen instead so it does not steal focus.
 */
async function renderScene(
  root: string,
  args: { scene?: string; width: number; height: number; frames: number; background?: string },
  outFile: string,
): Promise<void> {
  const info = loadProject(root);
  const scene = args.scene ? toResPath(args.scene, root) : info.mainScene;
  if (!scene) {
    throw new GodotAssistantError(
      "No scene given and this project has no main scene set.",
      "Pass `scene` with the scene to render.",
    );
  }

  const payload = JSON.stringify({
    scene,
    out: outFile,
    frames: args.frames,
    background: args.background ?? "",
  });

  const result = await runGodot(
    [
      "--path",
      root,
      "--script",
      CAPTURE_SCRIPT,
      "--resolution",
      `${args.width}x${args.height}`,
      "--position",
      "6000,6000",
      "--",
      payload,
    ],
    { cwd: root, timeoutMs: 60_000 },
  );

  if (result.timedOut) {
    throw new GodotAssistantError(
      "Rendering timed out.",
      "The scene may block in _ready() or wait for input. Try a smaller scene, or run it with run_project to see what it is doing.",
    );
  }

  const start = result.stdout.indexOf(BEGIN);
  const end = result.stdout.indexOf(END);
  if (start === -1 || end === -1) {
    const errors = result.diagnostics
      .filter((d) => d.severity !== "warning")
      .slice(0, 6)
      .map((d) => `  ${d.message}${d.file ? ` [${d.file}:${d.line ?? "?"}]` : ""}`)
      .join("\n");
    throw new GodotAssistantError(
      `Could not render ${scene}.${errors ? `\n\nGodot reported:\n${errors}` : ""}`,
      "On a headless machine with no display there is no renderer available; scene screenshots need a graphical session.",
    );
  }

  const payloadJson = result.stdout.slice(start + BEGIN.length, end).trim();
  const parsed = JSON.parse(payloadJson) as { ok: boolean; error?: string; hint?: string };
  if (!parsed.ok) {
    throw new GodotAssistantError(parsed.error ?? "Rendering failed.", parsed.hint);
  }
}

