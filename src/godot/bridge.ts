/**
 * Client for the live bridge exposed by the optional editor plugin.
 *
 * The bridge is strictly an enhancement: when it is absent every tool that can
 * fall back to the command line does so, and only genuinely live capabilities
 * (editor state, running-game inspection, input) report it as missing. That
 * keeps first-run setup at zero steps.
 *
 * Discovery works through a small file the plugin writes into `.godot/`, which
 * is the engine's own cache directory and is git-ignored everywhere. Nothing
 * needs to agree on a port number in advance, so several projects can be open
 * at once without colliding.
 */

import { readFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { GodotAssistantError } from "../util/errors.js";

export type BridgeRole = "editor" | "runtime";

export interface Discovery {
  protocol: number;
  role: BridgeRole;
  port: number;
  token: string;
  pid: number;
  godot_version: string;
  started_unix: number;
}

export interface BridgeResponse {
  ok: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

const SUPPORTED_PROTOCOL = 1;

export function discoveryPath(projectRoot: string, role: BridgeRole): string {
  return path.join(projectRoot, ".godot", `godot-assistant-${role}.json`);
}

/** Reads the advertisement file, if the corresponding side is running. */
export function readDiscovery(projectRoot: string, role: BridgeRole): Discovery | null {
  const file = discoveryPath(projectRoot, role);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Discovery;
    if (!parsed.port || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * True when the advertised process is genuinely alive.
 *
 * A crashed editor leaves its discovery file behind, and without this check
 * every bridge call would hang until its timeout on a dead port.
 */
export function isAlive(discovery: Discovery): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(discovery.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface BridgeStatus {
  available: boolean;
  role: BridgeRole;
  reason?: string;
  discovery?: Discovery;
}

export function bridgeStatus(projectRoot: string, role: BridgeRole): BridgeStatus {
  const discovery = readDiscovery(projectRoot, role);
  if (!discovery) {
    return {
      available: false,
      role,
      reason:
        role === "editor"
          ? "The Godot editor is not running with the godot-assistant plugin enabled."
          : "No godot-assistant-instrumented game is running.",
    };
  }
  if (discovery.protocol !== SUPPORTED_PROTOCOL) {
    return {
      available: false,
      role,
      reason: `Bridge protocol ${discovery.protocol} is not supported (this server speaks ${SUPPORTED_PROTOCOL}). Update the addon with bridge_install.`,
      discovery,
    };
  }
  if (!isAlive(discovery)) {
    return {
      available: false,
      role,
      reason: `A stale bridge file points at process ${discovery.pid}, which is no longer running.`,
      discovery,
    };
  }
  return { available: true, role, discovery };
}

/**
 * Sends one command over a short-lived connection.
 *
 * Connections are not pooled deliberately: MCP calls are sparse and a pooled
 * socket that dies between calls turns every subsequent call into a confusing
 * failure. Reconnecting costs under a millisecond on loopback.
 */
export function sendCommand(
  discovery: Discovery,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: discovery.port });
    let buffer = "";
    let authed = false;
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      done(() =>
        reject(
          new GodotAssistantError(
            `Bridge command "${command}" timed out after ${timeoutMs / 1000}s.`,
            "The Godot editor or game may be busy or stopped responding. Check it is still running.",
          ),
        ),
      );
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ token: discovery.token }) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message: BridgeResponse;
        try {
          message = JSON.parse(line) as BridgeResponse;
        } catch {
          done(() => reject(new GodotAssistantError("Malformed reply from the Godot bridge.")));
          return;
        }

        if (!authed) {
          if (!message.ok) {
            done(() =>
              reject(
                new GodotAssistantError(
                  "The Godot bridge rejected our token.",
                  "The editor was probably restarted. This resolves itself on the next call; if it persists, disable and re-enable the godot-assistant plugin in Godot.",
                ),
              ),
            );
            return;
          }
          authed = true;
          socket.write(JSON.stringify({ id: 1, cmd: command, params }) + "\n");
          continue;
        }

        done(() => resolve(message));
        return;
      }
    });

    socket.on("error", (error) => {
      done(() =>
        reject(
          new GodotAssistantError(
            `Could not reach the Godot bridge on port ${discovery.port}: ${error.message}`,
            "The editor or game it belongs to has probably closed. Run godot_status to re-check.",
          ),
        ),
      );
    });

    socket.on("close", () => {
      done(() =>
        reject(new GodotAssistantError("The Godot bridge closed the connection unexpectedly.")),
      );
    });
  });
}

/** Sends a command, converting an unavailable bridge into a directed error. */
export async function requireBridge(
  projectRoot: string,
  role: BridgeRole,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<BridgeResponse> {
  const status = bridgeStatus(projectRoot, role);
  if (!status.available || !status.discovery) {
    throw new GodotAssistantError(
      `This needs the live ${role} bridge, which is not available. ${status.reason ?? ""}`.trim(),
      role === "editor"
        ? "Run `bridge_install` to add the addon to this project, then open the project in the Godot editor. If it is already installed, enable it under Project > Project Settings > Plugins."
        : "Start the game with `run_project` after installing the addon with `bridge_install`. The runtime bridge only exists while a debug build is running.",
    );
  }
  const response = await sendCommand(status.discovery, command, params, timeoutMs);
  if (!response.ok) {
    throw new GodotAssistantError(
      response.error ?? `Bridge command "${command}" failed.`,
      response.hint,
    );
  }
  return response;
}
