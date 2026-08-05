#!/usr/bin/env node
/**
 * godot-assistant — entry point.
 *
 * Runs as an MCP stdio server by default. Two subcommands exist for setup:
 *   godot-assistant doctor    diagnose the environment
 *   godot-assistant install   print client configuration snippets
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { locateGodot } from "./godot/locate.js";
import { findProjectRoot, loadProject } from "./godot/project.js";
import { stopAll } from "./godot/process.js";
import { bridgeStatus } from "./godot/bridge.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Cli {
  command: "serve" | "doctor" | "install" | "version" | "help";
  project?: string;
  godot?: string;
  readOnly: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { command: "serve", readOnly: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--project":
      case "-p":
        cli.project = argv[++i];
        break;
      case "--godot":
      case "-g":
        cli.godot = argv[++i];
        break;
      case "--read-only":
        cli.readOnly = true;
        break;
      case "--version":
      case "-v":
        cli.command = "version";
        break;
      case "--help":
      case "-h":
        cli.command = "help";
        break;
      default:
        if (arg.startsWith("--project=")) cli.project = arg.slice(10);
        else if (arg.startsWith("--godot=")) cli.godot = arg.slice(8);
        else if (!arg.startsWith("-")) rest.push(arg);
        break;
    }
  }

  const sub = rest[0];
  if (sub === "doctor" || sub === "install") cli.command = sub;
  // A bare path argument is treated as the project, which is the form people
  // reach for first: `npx godot-assistant /path/to/game`.
  else if (sub && !cli.project) cli.project = sub;

  return cli;
}

const HELP = `${SERVER_NAME} ${SERVER_VERSION} — MCP server for the Godot Engine

Usage:
  godot-assistant [options]            run as an MCP stdio server (default)
  godot-assistant doctor [options]     check the environment and exit
  godot-assistant install              print client configuration snippets

Options:
  -p, --project <path>   Godot project folder, so tool calls can omit it
  -g, --godot <path>     path to the Godot executable (else auto-detected)
      --read-only        refuse every tool that modifies the project
  -v, --version          print the version
  -h, --help             this text

Environment:
  GODOT_PATH                    path to the Godot executable
  GODOT_ASSISTANT_PROJECT       default project folder
  GODOT_ASSISTANT_READ_ONLY=1   same as --read-only`;

async function doctor(cli: Cli): Promise<number> {
  const out: string[] = [`${SERVER_NAME} ${SERVER_VERSION}`, ""];
  let failures = 0;

  out.push(`node: ${process.version}`);

  try {
    const binary = await locateGodot(cli.godot ?? process.env["GODOT_PATH"]);
    out.push(`godot: ${binary.version}`);
    out.push(`  path: ${binary.path}`);
    out.push(`  found via: ${binary.source}`);
    out.push(`  C# support: ${binary.dotnet ? "yes" : "no"}`);
    if (binary.semver[0] < 4) {
      out.push("  PROBLEM: Godot 4.0 or newer is required.");
      failures++;
    }
  } catch (error) {
    out.push(`godot: NOT FOUND`);
    out.push(`  ${(error as Error).message}`);
    const remedy = (error as { remedy?: string }).remedy;
    if (remedy) out.push(remedy.split("\n").map((l) => `  ${l}`).join("\n"));
    failures++;
  }

  const projectInput = cli.project ?? process.env["GODOT_ASSISTANT_PROJECT"];
  if (projectInput) {
    const root = findProjectRoot(projectInput);
    if (!root) {
      out.push(`project: NOT FOUND at ${projectInput}`);
      out.push("  No project.godot at or above that path.");
      failures++;
    } else {
      const info = loadProject(root);
      out.push(`project: ${info.name}`);
      out.push(`  path: ${root}`);
      out.push(`  main scene: ${info.mainScene ?? "(not set)"}`);
      out.push(`  language: ${info.dotnet ? "C# (.NET)" : "GDScript"}`);
      const editor = bridgeStatus(root, "editor");
      out.push(`  live bridge: ${editor.available ? "connected" : "not running (optional)"}`);
    }
  } else {
    out.push("project: not configured (pass --project, or supply `project` per tool call)");
  }

  out.push("");
  out.push(failures === 0 ? "All checks passed." : `${failures} problem(s) found.`);
  process.stdout.write(out.join("\n") + "\n");
  return failures === 0 ? 0 : 1;
}

function install(): number {
  const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const out = `${SERVER_NAME} ${SERVER_VERSION} — client setup

Claude Code
  claude mcp add godot-assistant -- npx -y godot-assistant

  Scoped to one project (recommended — tool calls can then omit \`project\`):
  claude mcp add godot-assistant -- npx -y godot-assistant --project /path/to/game

Codex CLI  (~/.codex/config.toml)
  [mcp_servers.godot-assistant]
  command = "npx"
  args = ["-y", "godot-assistant", "--project", "/path/to/game"]

Claude Desktop / Cursor / Windsurf / Cline  (mcp.json)
  {
    "mcpServers": {
      "godot-assistant": {
        "command": "npx",
        "args": ["-y", "godot-assistant", "--project", "/path/to/game"]
      }
    }
  }

This local checkout instead of npx:
  node ${binPath} --project /path/to/game

If Godot is not auto-detected, add it to the config:
  "env": { "GODOT_PATH": "/Applications/Godot.app/Contents/MacOS/Godot" }

Verify with:  npx -y godot-assistant doctor --project /path/to/game
`;
  process.stdout.write(out);
  return 0;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.command === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (cli.command === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (cli.command === "install") {
    process.exit(install());
  }

  // An explicit --godot wins over the environment for the rest of the process.
  if (cli.godot) process.env["GODOT_PATH"] = cli.godot;

  if (cli.command === "doctor") {
    process.exit(await doctor(cli));
  }

  const server = createServer({
    defaultProject: cli.project ?? process.env["GODOT_ASSISTANT_PROJECT"],
    readOnly: cli.readOnly || process.env["GODOT_ASSISTANT_READ_ONLY"] === "1",
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Never leave orphaned Godot processes behind when the client disconnects.
  const shutdown = async () => {
    await stopAll().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((error) => {
  // stdout is the MCP transport, so diagnostics must go to stderr.
  process.stderr.write(`${SERVER_NAME}: fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
