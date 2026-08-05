/**
 * Scene and node editing tools.
 *
 * Node trees are rendered as indented text rather than JSON: the shape is the
 * information, and indentation conveys it in a fraction of the tokens that
 * nested objects with repeated "children"/"name"/"type" keys would cost.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operation } from "../godot/cli.js";
import { assertClassName, assertExtension, assertNodePath, toResPath } from "../util/paths.js";
import { joinSections, kv, pluralize, section, table } from "../util/text.js";
import { guard, projectParam, text, type ToolContext } from "./common.js";

interface TreeNode {
  name: string;
  type: string;
  script?: string;
  instance?: string;
  groups?: string[];
  children?: TreeNode[];
  truncated_children?: number;
}

/** Indented one-line-per-node rendering. */
function renderTree(node: TreeNode, depth = 0, out: string[] = []): string[] {
  const pad = "  ".repeat(depth);
  const bits = [`${pad}${node.name}`, `(${node.type})`];
  if (node.instance) bits.push(`instance of ${node.instance}`);
  if (node.script) bits.push(`script ${node.script}`);
  if (node.groups?.length) bits.push(`groups: ${node.groups.join(",")}`);
  out.push(bits.join(" "));
  for (const child of node.children ?? []) renderTree(child, depth + 1, out);
  if (node.truncated_children) {
    out.push(`${pad}  … ${node.truncated_children} more children (raise max_depth)`);
  }
  return out;
}

const propertiesParam = z
  .record(z.any())
  .optional()
  .describe(
    'Property values. JSON types are converted automatically: [x,y] -> Vector2, [x,y,z] -> Vector3, "#rrggbb" -> Color, "res://..." -> loaded resource, "CONSTANT_NAME" -> enum value.',
  );

export function registerSceneTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "scene_tree",
    {
      title: "Read scene tree",
      description:
        "Show a scene's node hierarchy with types, attached scripts, instanced sub-scenes and groups. Read this before editing any scene.",
      inputSchema: {
        project: projectParam,
        scene: z.string().describe('Scene path, e.g. "res://levels/main.tscn".'),
        max_depth: z.number().int().min(0).default(0).describe("0 = unlimited."),
      },
    },
    guard(async ({ project, scene, max_depth }: { project?: string; scene: string; max_depth: number }) => {
      const root = ctx.project(project);
      const scenePath = toResPath(scene, root);
      assertExtension(scenePath, [".tscn", ".scn"], "Scene");
      const result = await operation("scene_tree", { scene: scenePath, max_depth }, root);
      const tree = result["tree"] as TreeNode;
      return text(
        joinSections(
          `${scenePath}${result["uid"] ? `  ${result["uid"]}` : ""}`,
          renderTree(tree).join("\n"),
        ),
      );
    }),
  );

  server.registerTool(
    "scene_create",
    {
      title: "Create scene",
      description:
        "Create a new .tscn with a chosen root node type, optionally attaching a script. Assigns a stable uid:// so other scenes can reference it.",
      inputSchema: {
        project: projectParam,
        scene: z.string().describe('Where to create it, e.g. "res://enemies/slime.tscn".'),
        root_type: z
          .string()
          .default("Node2D")
          .describe("Root node class, e.g. Node2D, Node3D, Control, CharacterBody2D."),
        root_name: z.string().optional().describe("Root node name. Defaults to the file name."),
        script: z.string().optional().describe("Existing script to attach to the root."),
        overwrite: z.boolean().default(false),
      },
    },
    guard(
      async ({
        project,
        scene,
        root_type,
        root_name,
        script,
        overwrite,
      }: {
        project?: string;
        scene: string;
        root_type: string;
        root_name?: string;
        script?: string;
        overwrite: boolean;
      }) => {
        ctx.assertWritable("scene_create");
        const root = ctx.project(project);
        const scenePath = toResPath(scene, root);
        assertExtension(scenePath, [".tscn"], "Scene");
        const result = await operation(
          "scene_create",
          {
            scene: scenePath,
            root_type: assertClassName(root_type, "root_type"),
            root_name: root_name ?? "",
            script: script ? toResPath(script, root) : "",
            overwrite,
          },
          root,
        );
        return text(
          `Created ${result["scene"]}\nroot: ${root_name ?? "(file name)"} (${root_type})${result["uid"] ? `\nuid: ${result["uid"]}` : ""}`,
        );
      },
    ),
  );

  server.registerTool(
    "node_add",
    {
      title: "Add nodes to scene",
      description:
        "Add one or more nodes to a scene in a single save. Batch related nodes together — each call reloads and rewrites the scene file.",
      inputSchema: {
        project: projectParam,
        scene: z.string().describe("Scene to modify."),
        nodes: z
          .array(
            z.object({
              type: z.string().describe("Engine class, e.g. Sprite2D, CollisionShape2D, Label."),
              name: z.string().optional().describe("Node name. Defaults to the class name."),
              parent: z
                .string()
                .default(".")
                .describe('Parent node path within the scene; "." is the root.'),
              script: z.string().optional().describe("Script to attach."),
              properties: propertiesParam,
              groups: z.array(z.string()).optional(),
            }),
          )
          .min(1)
          .describe("Nodes to add, applied in order so a later node can target an earlier one."),
        force: z
          .boolean()
          .default(false)
          .describe("Save even if script references would be lost. Only use when that is intended."),
      },
    },
    guard(
      async ({
        project,
        scene,
        nodes,
        force,
      }: {
        project?: string;
        scene: string;
        nodes: Array<Record<string, unknown>>;
        force: boolean;
      }) => {
        ctx.assertWritable("node_add");
        const root = ctx.project(project);
        const scenePath = toResPath(scene, root);

        const prepared = nodes.map((n) => ({
          ...n,
          type: assertClassName(String(n["type"] ?? ""), "type"),
          parent: assertNodePath(String(n["parent"] ?? ".")),
          script: n["script"] ? toResPath(String(n["script"]), root) : "",
        }));

        const result = await operation("node_add", { scene: scenePath, nodes: prepared, force }, root);
        const added = (result["added"] ?? []) as Array<{ path: string; type: string }>;
        const warnings = (result["warnings"] ?? []) as string[];
        return text(
          joinSections(
            `Added ${pluralize(added.length, "node")} to ${scenePath}`,
            table(added.map((a) => [a.path, a.type]), ["path", "type"]),
            warnings.length ? section("Warnings", warnings.join("\n")) : "",
          ),
        );
      },
    ),
  );

  server.registerTool(
    "node_modify",
    {
      title: "Modify nodes",
      description:
        "Apply a batch of edits to a scene: set properties, rename, delete, reparent, reorder, attach/detach scripts, manage groups. All operations are applied then saved once.",
      inputSchema: {
        project: projectParam,
        scene: z.string(),
        operations: z
          .array(
            z.object({
              action: z.enum([
                "set_properties",
                "rename",
                "delete",
                "reparent",
                "move",
                "attach_script",
                "detach_script",
                "add_to_group",
                "remove_from_group",
              ]),
              node: z.string().describe('Target node path; "." is the scene root.'),
              properties: propertiesParam,
              name: z.string().optional().describe("New name, for rename."),
              to: z.string().optional().describe("New parent path, for reparent."),
              index: z.number().int().optional().describe("Sibling index, for move."),
              script: z.string().optional().describe("Script path, for attach_script."),
              group: z.string().optional().describe("Group name, for group actions."),
            }),
          )
          .min(1),
        force: z.boolean().default(false).describe("Save even if script references would be lost."),
      },
    },
    guard(
      async ({
        project,
        scene,
        operations,
        force,
      }: {
        project?: string;
        scene: string;
        operations: Array<Record<string, unknown>>;
        force: boolean;
      }) => {
        ctx.assertWritable("node_modify");
        const root = ctx.project(project);
        const scenePath = toResPath(scene, root);

        const prepared = operations.map((op) => ({
          ...op,
          node: assertNodePath(String(op["node"] ?? ".")),
          ...(op["to"] ? { to: assertNodePath(String(op["to"])) } : {}),
          ...(op["script"] ? { script: toResPath(String(op["script"]), root) } : {}),
        }));

        const result = await operation(
          "node_modify",
          { scene: scenePath, operations: prepared, force },
          root,
        );
        const applied = (result["applied"] ?? []) as string[];
        const warnings = (result["warnings"] ?? []) as string[];
        return text(
          joinSections(
            `${scenePath} — ${pluralize(applied.length, "change")}`,
            applied.map((a) => `- ${a}`).join("\n"),
            warnings.length ? section("Warnings", warnings.join("\n")) : "",
          ),
        );
      },
    ),
  );

  server.registerTool(
    "node_inspect",
    {
      title: "Inspect node",
      description:
        "Full detail for one node: type, inheritance chain, script, groups, signal connections, and properties that differ from their defaults.",
      inputSchema: {
        project: projectParam,
        scene: z.string(),
        node: z.string().default(".").describe('Node path; "." is the scene root.'),
        include_defaults: z
          .boolean()
          .default(false)
          .describe("Include properties still at their engine default. Verbose; usually not needed."),
      },
    },
    guard(
      async ({
        project,
        scene,
        node,
        include_defaults,
      }: {
        project?: string;
        scene: string;
        node: string;
        include_defaults: boolean;
      }) => {
        const root = ctx.project(project);
        const scenePath = toResPath(scene, root);
        const result = await operation(
          "node_inspect",
          { scene: scenePath, node: assertNodePath(node), include_defaults },
          root,
        );

        const props = (result["properties"] ?? []) as Array<{ name: string; type: string; value: string }>;
        const connections = (result["connections"] ?? []) as Array<{
          direction: string;
          signal: string;
          peer: string;
          method: string;
        }>;
        const inherits = (result["inherits"] ?? []) as string[];

        return text(
          joinSections(
            kv([
              ["node", `${result["name"]} (${result["type"]})`],
              ["path", `${scenePath} :: ${node}`],
              ["inherits", inherits.slice(0, 6).join(" < ")],
              ["script", result["script"] || "(none)"],
              ["groups", (result["groups"] as string[])?.join(", ") || "(none)"],
              ["children", String(result["children"])],
            ]),
            section(
              include_defaults ? "Properties" : "Properties (non-default only)",
              props.length ? table(props.map((p) => [p.name, p.value, p.type]), ["property", "value", "type"]) : "(all at defaults)",
            ),
            section(
              "Signal connections",
              connections.length
                ? connections
                    .map((c) => {
                      // "." is the scene root; spelling it out reads far better
                      // than the literal path next to a method name.
                      const peer = c.peer === "." ? "root" : c.peer;
                      return c.direction === "out"
                        ? `emits ${c.signal} -> ${peer}.${c.method}()`
                        : `receives ${peer}.${c.signal} -> this.${c.method}()`;
                    })
                    .join("\n")
                : "(none)",
            ),
          ),
        );
      },
    ),
  );

  server.registerTool(
    "scene_instance",
    {
      title: "Instance a scene",
      description:
        "Place one scene inside another as an instance (not a copy), so later edits to the source propagate. This is how prefabs work in Godot.",
      inputSchema: {
        project: projectParam,
        scene: z.string().describe("Scene that receives the instance."),
        instance: z.string().describe("Scene to instance into it."),
        parent: z.string().default(".").describe("Parent node path inside the receiving scene."),
        name: z.string().optional().describe("Name for the instance node."),
        count: z.number().int().min(1).max(200).default(1).describe("Create this many, numbered."),
        properties: propertiesParam,
        force: z.boolean().default(false),
      },
    },
    guard(
      async (args: {
        project?: string;
        scene: string;
        instance: string;
        parent: string;
        name?: string;
        count: number;
        properties?: Record<string, unknown>;
        force: boolean;
      }) => {
        ctx.assertWritable("scene_instance");
        const root = ctx.project(args.project);
        const result = await operation(
          "scene_instance",
          {
            scene: toResPath(args.scene, root),
            instance: toResPath(args.instance, root),
            parent: assertNodePath(args.parent),
            name: args.name ?? "",
            count: args.count,
            properties: args.properties ?? {},
            force: args.force,
          },
          root,
        );
        const created = (result["instanced"] ?? []) as string[];
        return text(
          `Instanced ${result["source"]} into ${result["scene"]}\n${created.map((c) => `- ${c}`).join("\n")}`,
        );
      },
    ),
  );

  server.registerTool(
    "signal_connect",
    {
      title: "Connect signals",
      description:
        "Connect or disconnect a signal between nodes in a scene, persisted into the .tscn exactly as the editor writes it. The receiving method must exist on the target's script.",
      inputSchema: {
        project: projectParam,
        scene: z.string(),
        action: z.enum(["connect", "disconnect"]).default("connect"),
        from: z.string().default(".").describe("Node emitting the signal."),
        signal: z.string().describe('Signal name, e.g. "pressed", "body_entered".'),
        to: z.string().default(".").describe("Node receiving it."),
        method: z.string().describe('Method to call, e.g. "_on_button_pressed".'),
        deferred: z.boolean().default(false),
        one_shot: z.boolean().default(false),
        force: z.boolean().default(false),
      },
    },
    guard(
      async (args: {
        project?: string;
        scene: string;
        action: string;
        from: string;
        signal: string;
        to: string;
        method: string;
        deferred: boolean;
        one_shot: boolean;
        force: boolean;
      }) => {
        ctx.assertWritable("signal_connect");
        const root = ctx.project(args.project);
        const result = await operation(
          "signal_edit",
          {
            scene: toResPath(args.scene, root),
            action: args.action,
            from: assertNodePath(args.from),
            to: assertNodePath(args.to),
            signal: args.signal,
            method: args.method,
            deferred: args.deferred,
            one_shot: args.one_shot,
            force: args.force,
          },
          root,
        );
        return text(`${result["action"]}: ${result["detail"]}\nin ${result["scene"]}`);
      },
    ),
  );
}
