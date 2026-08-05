/**
 * Shared plumbing for tool definitions.
 */

import { z } from "zod";
import { GodotAssistantError } from "../util/errors.js";
import { loadProject, requireProjectRoot, type ProjectInfo } from "../godot/project.js";
import { truncate } from "../util/text.js";

/** Server-wide settings resolved once at startup. */
export interface ServerConfig {
  /** Implied project when a tool call omits `project`. */
  defaultProject?: string;
  /** Refuse every mutating tool. */
  readOnly: boolean;
}

export interface ToolContext {
  config: ServerConfig;
  /** Resolves and validates the project root for a call. */
  project(input?: string): string;
  /** Resolves and parses project.godot. */
  info(input?: string): ProjectInfo;
  /** Throws when the server is running read-only. */
  assertWritable(tool: string): void;
}

export function createContext(config: ServerConfig): ToolContext {
  return {
    config,
    project(input?: string): string {
      return requireProjectRoot(input, config.defaultProject);
    },
    info(input?: string): ProjectInfo {
      return loadProject(requireProjectRoot(input, config.defaultProject));
    },
    assertWritable(tool: string): void {
      if (config.readOnly) {
        throw new GodotAssistantError(
          `${tool} modifies the project, but this server is running in read-only mode.`,
          "Remove --read-only (or GODOT_ASSISTANT_READ_ONLY) from the MCP server configuration to allow edits.",
        );
      }
    },
  };
}

/**
 * The `project` parameter, shared by every tool.
 *
 * Optional so that a server started with `--project` needs no repetition, which
 * removes a token of overhead from every single call in the common one-project
 * case.
 */
export const projectParam = z
  .string()
  .optional()
  .describe("Godot project folder (the one with project.godot). Optional if the server was started with --project.");

export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export function text(body: string): ToolResult {
  return { content: [{ type: "text", text: truncate(body) }] };
}

export function image(base64: string, mimeType: string, caption?: string): ToolResult {
  const content: ToolResult["content"] = [{ type: "image", data: base64, mimeType }];
  if (caption) content.push({ type: "text", text: caption });
  return { content };
}

export function failure(error: unknown): ToolResult {
  const message =
    error instanceof GodotAssistantError
      ? error.toString()
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text: truncate(message, 8000) }], isError: true };
}

/**
 * Wraps a handler so any thrown error becomes a readable tool error rather than
 * a protocol-level failure. Agents recover from the former and stall on the latter.
 */
export function guard<A>(handler: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return failure(error);
    }
  };
}
