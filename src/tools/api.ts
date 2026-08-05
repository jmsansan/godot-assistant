/**
 * Engine API reference.
 *
 * Godot's API changed substantially between 3.x and 4.x and keeps moving across
 * 4.x minors, so a model working from memory reliably invents method names,
 * mixes up signal signatures, and reaches for properties that no longer exist.
 * Querying the live ClassDB of the *installed* engine replaces that guesswork
 * with a lookup, and it is the cheapest quality win in the whole server.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operation } from "../godot/cli.js";
import { joinSections, kv, paginate, section, table } from "../util/text.js";
import { guard, projectParam, text, type ToolContext } from "./common.js";

export function registerApiTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "api_reference",
    {
      title: "Godot API reference",
      description:
        "Look up a Godot class in the installed engine: methods with full signatures, properties with defaults, signals, enums, inheritance. Use this instead of recalling the API — it reflects the exact engine version in use.",
      inputSchema: {
        project: projectParam,
        query: z
          .string()
          .describe('Class name ("CharacterBody2D") or a search term ("Body2D", "tween").'),
        kind: z
          .enum(["all", "methods", "properties", "signals", "constants"])
          .default("all")
          .describe("Narrow the response. Use a specific kind to save context."),
        inherited: z
          .boolean()
          .default(false)
          .describe("Include members from parent classes. Off by default: the inherited set is large."),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(400).default(120),
      },
    },
    guard(
      async ({
        project,
        query,
        kind,
        inherited,
        offset,
        limit,
      }: {
        project?: string;
        query: string;
        kind: string;
        inherited: boolean;
        offset: number;
        limit: number;
      }) => {
        const root = ctx.project(project);
        const result = await operation("api_reference", { query, kind, inherited }, root);

        // Ambiguous search: return the candidate list so the agent can pick.
        if (result["matches"]) {
          const matches = result["matches"] as string[];
          return text(
            joinSections(
              `${result["match_count"]} classes match "${query}":`,
              matches.join("\n"),
              "Call again with an exact class name for details.",
            ),
          );
        }

        const parts: string[] = [
          kv([
            ["class", String(result["class"])],
            ["inherits", (result["inherits"] as string[])?.join(" < ") || "(none)"],
            ["instantiable", result["instantiable"] ? "yes" : "no"],
            ["is a Node", result["is_node"] ? "yes" : "no"],
          ]),
        ];

        const methods = (result["methods"] ?? []) as string[];
        if (methods.length) {
          parts.push(
            section(
              inherited ? "Methods" : "Methods (declared on this class)",
              paginate(methods, offset, limit, (m) => m),
            ),
          );
        }

        const properties = (result["properties"] ?? []) as Array<{ name: string; type: string; default: string }>;
        if (properties.length) {
          parts.push(
            section(
              inherited ? "Properties" : "Properties (declared on this class)",
              table(
                properties.slice(offset, offset + limit).map((p) => [p.name, p.type, p.default]),
                ["property", "type", "default"],
              ),
            ),
          );
        }

        const signals = (result["signals"] ?? []) as string[];
        if (signals.length) {
          parts.push(section("Signals", signals.join("\n")));
        }

        const enums = (result["enums"] ?? {}) as Record<string, string[]>;
        const enumNames = Object.keys(enums);
        if (enumNames.length) {
          parts.push(
            section(
              "Enums",
              enumNames.map((name) => `${name}: ${enums[name]!.join(", ")}`).join("\n"),
            ),
          );
        }

        if (!inherited && (methods.length || properties.length)) {
          parts.push("Members inherited from parent classes are omitted. Pass inherited=true to include them.");
        }

        return text(joinSections(...parts));
      },
    ),
  );
}
