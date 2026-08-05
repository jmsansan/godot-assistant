# godot-assistant

[![CI](https://github.com/jmsansan/godot-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/jmsansan/godot-assistant/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/godot-assistant?color=1a6ab0)](https://www.npmjs.com/package/godot-assistant)
[![Godot 4.3+](https://img.shields.io/badge/godot-4.3%20to%204.7-478cbf)](https://godotengine.org/download)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

An MCP server that lets an AI coding agent actually work on a **Godot 4** project: read scenes, edit node trees, write and validate GDScript, run the game, and **look at what it built**.

**[jmsansan.github.io/godot-assistant](https://jmsansan.github.io/godot-assistant/)**

Works with Claude Code, Codex, Cursor, Claude Desktop, Cline, Windsurf, or any MCP client.

```bash
claude mcp add godot-assistant -- npx -y godot-assistant --project /path/to/your/game
```

That is the whole installation. No addon to copy, no build step, no project changes.

---

## Why another Godot MCP

Existing servers land on one of two extremes. One is command-line only: easy to install, but it cannot see the editor, cannot see the running game, and cannot show you a single pixel, so an agent works blind and finds out something is wrong only when it crashes. The other exposes 175 tools through a mandatory editor plugin, which is enough tool definitions to measurably degrade the model doing the work.

godot-assistant takes the middle path deliberately:

**Zero-setup by default.** Every core capability (reading scenes, editing nodes, writing scripts, validating, running, **and rendering a scene to a PNG**) runs through the Godot binary you already have. Nothing is written into your project.

**Live features when you want them.** One call to `bridge_install` adds a small optional addon that unlocks inspecting the running game, simulating input, and screenshotting the game and editor. Without it, those tools fail with an explanation instead of a stack trace; everything else is unaffected.

**25 tools, not 175.** Grouped by intent with batched operations, so the model spends its context on your game instead of on tool definitions. The full set costs about 6.5k tokens.

**It refuses to corrupt your scenes.** See [Safety](#safety).

---

## Quick start

**Prerequisites:** Godot 4.x ([download](https://godotengine.org/download)) and Node.js 18+. Godot is auto-detected on macOS, Windows and Linux, including Homebrew, Scoop, Snap and Flatpak installs.

### Claude Code

```bash
claude mcp add godot-assistant -- npx -y godot-assistant --project /path/to/your/game
```

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.godot-assistant]
command = "npx"
args = ["-y", "godot-assistant", "--project", "/path/to/your/game"]
```

### Cursor / Claude Desktop / Cline / Windsurf

In your client's `mcp.json`:

```json
{
  "mcpServers": {
    "godot-assistant": {
      "command": "npx",
      "args": ["-y", "godot-assistant", "--project", "/path/to/your/game"]
    }
  }
}
```

`--project` is optional. Omit it and pass `project` per tool call instead. Setting it is recommended: it removes an argument from every call.

### Check the setup

```bash
npx -y godot-assistant doctor --project /path/to/your/game
```

```
godot-assistant 1.0.0

node: v22.11.0
godot: 4.7.1.stable.official
  path: /Applications/Godot.app/Contents/MacOS/Godot
  found via: standard install
  C# support: no
project: My Game
  path: /path/to/your/game
  main scene: res://scenes/main.tscn
  language: GDScript
  live bridge: not running (optional)

All checks passed.
```

`npx -y godot-assistant install` prints ready-to-paste config for every client.

---

## What you can ask for

> "Add a double jump to the player and show me it working."

The agent reads `player.gd`, checks `CharacterBody2D` against the real engine API, edits the script, validates it, runs the game, and screenshots the result.

> "The coin pickup isn't firing. Why?"

`scene_tree` on the level, `node_inspect` on the coin to see its signal wiring, `search` for the handler, `run_project` to read the actual error with a file and line number.

> "Build a pause menu."

`api_reference` for `Control` and `Button`, `scene_create`, `node_add` for the layout in one batch, `signal_connect` to wire the buttons, `screenshot` to check it looks right.

---

## Tools

**Discovery**

| Tool | What it does |
|---|---|
| `godot_status` | Engine, project, bridge and process health. Start here. |
| `project_info` | Main scene, autoloads, input actions, layers, file counts. |
| `list_files` | Project files by kind, with glob and paging. |
| `search` | Grep scripts, scenes and resources; returns `file:line`. |

**Engine API**

| Tool | What it does |
|---|---|
| `api_reference` | Methods, properties, signals and enums from the installed engine's ClassDB. |

This one matters more than it looks. Godot's API changed substantially at 4.0 and keeps moving across minors, so a model working from memory invents method names and mixes up signal signatures. `api_reference` replaces recall with a lookup against the exact engine version in use.

**Scenes and nodes**

| Tool | What it does |
|---|---|
| `scene_tree` | Node hierarchy with types, scripts, instances and groups. |
| `scene_create` | New `.tscn` with a chosen root type, assigned a stable `uid://`. |
| `node_add` | Add nodes in a batch, with typed properties. |
| `node_modify` | Batch set-properties, rename, delete, reparent, reorder, scripts, groups. |
| `node_inspect` | One node in full: non-default properties, both directions of signal wiring. |
| `scene_instance` | Place a scene inside another as an instance (Godot's prefabs). |
| `signal_connect` | Connect/disconnect signals, persisted exactly as the editor writes them. |

**Scripting**

| Tool | What it does |
|---|---|
| `script_create` | Write a script and optionally attach it in one step. |
| `script_validate` | Parse-check one file or the whole project, with file and line. |

**Running and debugging**

| Tool | What it does |
|---|---|
| `run_project` | Run the game or one scene, windowed or headless. |
| `get_output` | Parsed, deduplicated console output. |
| `stop_project` | Stop cleanly. |

**Seeing**

| Tool | What it does |
|---|---|
| `screenshot` | Render any scene to PNG, no setup needed. Or capture the running game / editor (needs the bridge). |
| `runtime_inspect` | Live node tree, world positions and real property values while running. *(bridge)* |
| `simulate_input` | Send actions, keys, clicks into the running game. *(bridge)* |

**Assets, editor, export**

| Tool | What it does |
|---|---|
| `resource_manage` | Create, read and edit `.tres` resources. |
| `import_assets` | Find and fix unimported assets. |
| `editor_control` | Launch the editor; open scenes, play/stop, select nodes. *(bridge)* |
| `bridge_install` | Install, check or remove the optional live addon. |
| `export_project` | List presets and build. |

---

## Property values

JSON has no `Vector2`, so properties are converted for you:

```jsonc
{
  "position":  [100, 250],        // -> Vector2(100, 250)
  "scale":     [2, 2, 2],         // -> Vector3(2, 2, 2)
  "modulate":  "#ff8800",         // -> Color
  "texture":   "res://icon.png",  // -> loaded Resource
  "mouse_filter": "MOUSE_FILTER_IGNORE"  // -> enum constant
}
```

Anything else passes through with the property's declared type. A name that does not exist on the node is reported rather than silently dropped.

---

## The optional live bridge

```
bridge_install
```

Adds `addons/godot_assistant/` and enables it. This unlocks:

- `screenshot(source="game")` and `source="editor"`
- `simulate_input`: drive the game with synthetic input
- `runtime_inspect`: the live tree, including inside instanced scenes
- `editor_control`: open scenes, play/stop, read editor state

**Security posture.** The bridge listens on `127.0.0.1` only, requires a token regenerated every session, and refuses to start in non-debug builds so exported games never carry it. The discovery file lives in `.godot/`, which Godot already git-ignores. Port assignment is dynamic, so several projects can be open at once.

Remove it any time with `bridge_install action="uninstall"`.

---

## Safety

Scene files are the crown jewels of a Godot project and a bad write is easy to miss for hours. This server is built around not doing that.

**It will not silently drop your scripts.** Editing a scene means loading, mutating and repacking it. If a script fails to compile, the engine drops the reference and the save would quietly detach it from your node. That write is refused, with the offending script named and the file untouched. `force=true` is available when the removal is genuinely intended.

**It will not break your `uid://`.** Repacking a scene loses the UID in its header, which breaks every other scene referencing it. The UID is captured before the edit and restored after.

**It will not corrupt C# scenes.** A non-.NET Godot build cannot resolve `CSharpScript`, so editing a scene with C# attached strips those attachments. Detected up front and refused, with instructions.

**It will not run code you did not ask for.** Node types are validated as bare identifiers and checked against ClassDB on both sides, so a `res://payload.gd` passed as a node type is rejected rather than loaded and executed.

**It will not escape your project.** Paths are normalised, NUL-checked, and resolved through `realpath` before the containment check, so symlinks cannot step outside the project root.

**It will not hang.** Every engine invocation has a hard timeout and a kill escalation. (A headless Godot waiting on a rendered frame waits forever: a real thing this server works around.)

**Read-only mode.** `--read-only` (or `GODOT_ASSISTANT_READ_ONLY=1`) refuses every mutating tool while leaving inspection intact.

---

## Token efficiency

MCP responses are billed to the agent's context, so:

- **Plain text, not JSON.** A scene tree of 8 nodes is ~420 characters, roughly a third of the equivalent JSON.
- **Defaults elided.** `node_inspect` shows only properties that differ from engine defaults.
- **Duplicates collapsed.** An error thrown every frame appears once, with a count.
- **Engine noise filtered.** Leaked-RID warnings at shutdown are normal and are removed; agents otherwise chase them.
- **Everything paginates**, with an explicit `offset=` hint to resume.
- **25 tools** with compact schemas, about 6.5k tokens for the full set.

---

## Configuration

| Setting | Env | Flag |
|---|---|---|
| Godot executable | `GODOT_PATH` | `--godot <path>` |
| Default project | `GODOT_ASSISTANT_PROJECT` | `--project <path>` |
| Read-only | `GODOT_ASSISTANT_READ_ONLY=1` | `--read-only` |

Commands: `godot-assistant` (serve), `doctor`, `install`, `--help`, `--version`.

---

## Troubleshooting

**"Could not find a Godot executable."** Set `GODOT_PATH` in the MCP config's `env` block. On macOS point at the binary inside the bundle, not the `.app` folder:

```json
"env": { "GODOT_PATH": "/Applications/Godot.app/Contents/MacOS/Godot" }
```

**"No project.godot found."** Point `--project` at the folder containing `project.godot`. Any path *inside* the project also works, because it walks up.

**"Godot did not return a result."** Usually a script in the project fails to parse. Run `script_validate`.

**Screenshots time out or look stale.** The game window must be visible to render; `run_project` sets always-on-top by default for this reason. On a headless server with no display, scene rendering is unavailable, so use `headless=true` runs and read the console instead.

**C# project.** Install the .NET build of Godot and point `GODOT_PATH` at it. Scene edits touching C# are refused with a standard build rather than silently corrupting the file.

---

## Development

```bash
npm install
npm run build
npm test          # end-to-end suite against a real Godot binary
```

The QA suite builds a throwaway project with instanced scenes, sub-resources, exported overrides and signal connections, then drives the server over real MCP stdio: 109 checks covering protocol shape, scene-edit fidelity, path-traversal and code-execution rejection, live-bridge behaviour, graceful degradation, error quality and output size.

---

## License

MIT

---

## Support

If this saves you time, you can support the work on
[GitHub Sponsors](https://github.com/sponsors/jmsansan) or
[Ko-fi](https://ko-fi.com/jmsansan).
