/**
 * MCP server assembly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createContext, type ServerConfig } from "./tools/common.js";
import { registerProjectTools } from "./tools/project.js";
import { registerSceneTools } from "./tools/scene.js";
import { registerScriptTools } from "./tools/script.js";
import { registerApiTools } from "./tools/api.js";
import { registerRunTools } from "./tools/run.js";
import { registerVisualTools } from "./tools/visual.js";
import { registerResourceTools } from "./tools/resource.js";
import { registerEditorTools } from "./tools/editor.js";

export const SERVER_NAME = "godot-assistant";
export const SERVER_VERSION = "1.0.0";

/**
 * Guidance handed to the client at initialize time.
 *
 * Clients surface this to the model once per session, which makes it the
 * cheapest place to prevent the mistakes that would otherwise cost several
 * failed tool calls each: not reading a scene before editing it, guessing at
 * engine APIs, and never looking at what was built.
 */
export const INSTRUCTIONS = `Tools for working on Godot 4 projects.

Effective order of operations:
1. godot_status once, to confirm the engine and project are found.
2. api_reference before writing engine code. It queries the installed engine's
   ClassDB, so it is authoritative about method and signal names — do not rely
   on recalled Godot APIs, which changed between 3.x and 4.x.
3. scene_tree before editing any scene, to learn the real node paths.
4. script_validate after editing scripts. It is far faster than running.
5. screenshot to check the result. Most game bugs are visual and never appear
   in the console.

Notes:
- Batch node edits: node_add and node_modify each take a list, and every call
  rewrites the whole scene file.
- Scene edits refuse to drop script references rather than silently corrupting
  a scene. If one is refused, fix the script and retry.
- Paths accept "res://..." or project-relative form.
- Live features (running-game inspection, input simulation, game and editor
  screenshots) need a one-time bridge_install. Everything else needs no setup.`;

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  const ctx = createContext(config);

  registerProjectTools(server, ctx);
  registerSceneTools(server, ctx);
  registerScriptTools(server, ctx);
  registerApiTools(server, ctx);
  registerRunTools(server, ctx);
  registerVisualTools(server, ctx);
  registerResourceTools(server, ctx);
  registerEditorTools(server, ctx);

  return server;
}
