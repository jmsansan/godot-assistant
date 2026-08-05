/**
 * End-to-end QA suite.
 *
 * Drives the real server over real MCP stdio against a real Godot binary and a
 * real project. There are no mocks: the failure modes that matter here — a
 * scene rewritten lossily, a hung engine process, a path escape — only appear
 * against the actual engine.
 *
 * Run with:  npm run qa
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.mjs";
import { McpClient } from "./client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "..", "dist", "index.js");
const PROJECT = path.join(tmpdir(), "godot-assistant-qa");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? `\n       ${detail.split("\n").slice(0, 6).join("\n       ")}` : ""}`);
    process.stdout.write(`  FAIL ${name}\n${detail ? `       ${detail.split("\n").slice(0, 6).join("\n       ")}\n` : ""}`);
  }
}

function group(title) {
  process.stdout.write(`\n${title}\n`);
}

const scene = (rel) => readFileSync(path.join(PROJECT, rel), "utf8");

async function main() {
  process.stdout.write("godot-assistant QA\n==================\n");
  createFixture(PROJECT);

  const client = new McpClient("node", [entry, "--project", PROJECT]);
  const init = await client.initialize();

  group("Protocol");
  check("initialize returns server info", init?.serverInfo?.name === "godot-assistant");
  check(
    "instructions are provided to the client",
    typeof init?.instructions === "string" && init.instructions.length > 200,
  );

  const tools = await client.listTools();
  check(`tool list is non-empty (${tools.length} tools)`, tools.length >= 15);
  check(
    "tool count stays in the range clients handle well (<= 30)",
    tools.length <= 30,
    `got ${tools.length}`,
  );
  check(
    "every tool has a description",
    tools.every((t) => t.description && t.description.length > 30),
  );
  check(
    "every tool has an input schema",
    tools.every((t) => t.inputSchema && t.inputSchema.type === "object"),
  );

  const schemaBytes = JSON.stringify(tools).length;
  check(
    `tool definitions stay compact (${schemaBytes} bytes, ~${Math.round(schemaBytes / 4)} tokens)`,
    schemaBytes < 30_000,
    `${schemaBytes} bytes`,
  );

  group("Discovery");
  let r = await client.call("godot_status", {});
  let out = McpClient.textOf(r);
  check("godot_status finds the engine", /Godot 4\./.test(out), out);
  check("godot_status finds the project", /QA Fixture/.test(out), out);
  check("godot_status reports bridge as optional", /bridge/i.test(out), out);

  r = await client.call("project_info", {});
  out = McpClient.textOf(r);
  check("project_info lists the autoload", /GameState/.test(out), out);
  check("project_info lists the input action", /jump/.test(out), out);
  check("project_info decodes key bindings", /Space/.test(out), out);
  check("project_info lists named layers", /world/.test(out), out);

  r = await client.call("list_files", { kind: "scenes" });
  out = McpClient.textOf(r);
  check("list_files finds every scene", (out.match(/\.tscn/g) ?? []).length === 5, out);

  r = await client.call("search", { query: "jump_force" });
  out = McpClient.textOf(r);
  check("search finds a symbol with file:line", /player\.gd:\d+/.test(out), out);

  group("Engine API reference");
  r = await client.call("api_reference", { query: "CharacterBody2D", kind: "methods" });
  out = McpClient.textOf(r);
  check("api_reference returns real signatures", /move_and_slide\(\)/.test(out), out.slice(0, 300));
  check("api_reference shows the inheritance chain", /PhysicsBody2D/.test(out));

  r = await client.call("api_reference", { query: "Button", kind: "signals", inherited: true });
  out = McpClient.textOf(r);
  check("api_reference finds inherited signals", /pressed\(\)/.test(out), out.slice(0, 300));

  r = await client.call("api_reference", { query: "Body2D" });
  out = McpClient.textOf(r);
  check("api_reference disambiguates partial matches", /classes match/.test(out), out.slice(0, 200));

  group("Scene reading");
  r = await client.call("scene_tree", { scene: "res://scenes/main.tscn" });
  out = McpClient.textOf(r);
  check("scene_tree renders an indented hierarchy", /Main \(Node2D\)/.test(out), out);
  check("scene_tree marks instanced sub-scenes", /instance of res:\/\/scenes\/player\.tscn/.test(out), out);
  check("scene_tree does not descend into instances", !/Hitbox/.test(out), out);

  r = await client.call("node_inspect", { scene: "res://scenes/player.tscn", node: "." });
  out = McpClient.textOf(r);
  check("node_inspect reports the attached script", /scripts\/player\.gd/.test(out), out);
  check("node_inspect shows the exported override", /speed\s+300/.test(out), out);
  check(
    "node_inspect lists incoming signal connections",
    /receives Hitbox\.area_entered -> this\._on_area_entered/.test(out),
    out,
  );

  // Containers attach many internal connections at instantiation; reporting
  // them buries the one connection the user actually wrote.
  r = await client.call("node_inspect", { scene: "res://scenes/hud.tscn", node: "Rows/Start" });
  out = McpClient.textOf(r);
  check("node_inspect reports the authored connection", /emits pressed -> root\._on_start_pressed/.test(out), out);
  check(
    "node_inspect hides engine-internal container connections",
    !/queue_sort|_child_minsize_changed|_desired_size_changed/.test(out),
    out,
  );
  check(
    "node_inspect does not report unset object properties as changed",
    !/\bmaterial\b|\btheme\b|shortcut_context/.test(out),
    out,
  );

  group("Scene editing — fidelity");
  r = await client.call("node_add", {
    scene: "res://scenes/main.tscn",
    nodes: [
      { type: "Marker2D", name: "SpawnPoint", properties: { position: [64, 300] } },
      { type: "Camera2D", name: "Cam", parent: "Player", properties: { zoom: [1.5, 1.5] } },
    ],
  });
  out = McpClient.textOf(r);
  check("node_add reports both nodes", /SpawnPoint/.test(out) && /Player\/Cam/.test(out), out);

  const afterMain = scene("scenes/main.tscn");
  check("scene uid survives the edit", afterMain.includes('uid="uid://bqamain000001"'), afterMain.split("\n")[0]);
  check("instanced player survives", /instance=ExtResource/.test(afterMain));
  check("both sub-scene ext_resources survive", (afterMain.match(/ext_resource/g) ?? []).length === 2);
  check("new node was written with its property", /position = Vector2\(64, 300\)/.test(afterMain));
  check("existing instance override survives", /position = Vector2\(120, 200\)/.test(afterMain));

  r = await client.call("node_add", {
    scene: "res://scenes/player.tscn",
    nodes: [{ type: "Timer", name: "Cooldown", properties: { wait_time: 0.25, one_shot: true } }],
  });
  const player = scene("scenes/player.tscn");
  check("script reference survives editing a scripted scene", /scripts\/player\.gd/.test(player));
  check("sub-resource survives", /RectangleShape2D/.test(player), player);
  check("signal connection survives", /\[connection signal="area_entered"/.test(player), player);
  check("exported override survives", /speed = 300\.0/.test(player), player);
  check("new node applied typed properties", /wait_time = 0\.25/.test(player) && /one_shot = true/.test(player));

  group("Scene editing — operations");
  r = await client.call("node_modify", {
    scene: "res://scenes/main.tscn",
    operations: [
      { action: "rename", node: "SpawnPoint", name: "StartPoint" },
      { action: "set_properties", node: "Background", properties: { color: "#223344" } },
      { action: "add_to_group", node: "StartPoint", group: "spawns" },
    ],
  });
  out = McpClient.textOf(r);
  check("node_modify applies a batch", /3 changes/.test(out), out);
  const modified = scene("scenes/main.tscn");
  check("rename landed", /name="StartPoint"/.test(modified));
  check("colour property landed", /color = Color\(0\.13\d*, 0\.2/.test(modified), modified.match(/color = .*/g)?.join("\n"));
  check("group landed", /groups=\["spawns"\]/.test(modified), modified);

  r = await client.call("scene_create", {
    scene: "res://scenes/enemy.tscn",
    root_type: "CharacterBody2D",
    root_name: "Enemy",
  });
  check("scene_create writes a file", existsSync(path.join(PROJECT, "scenes/enemy.tscn")));
  check("scene_create assigns a uid", /uid:\s*uid:\/\//.test(McpClient.textOf(r)), McpClient.textOf(r));

  r = await client.call("scene_instance", {
    scene: "res://scenes/main.tscn",
    instance: "res://scenes/coin.tscn",
    count: 3,
    name: "Coin",
  });
  out = McpClient.textOf(r);
  check("scene_instance creates numbered copies", /Coin1/.test(out) && /Coin3/.test(out), out);

  group("Scripts");
  r = await client.call("script_create", {
    path: "res://scripts/enemy.gd",
    content: `extends CharacterBody2D

@export var patrol_speed: float = 40.0


func _physics_process(delta: float) -> void:
	velocity.x = patrol_speed
	move_and_slide()
`,
    attach_to_scene: "res://scenes/enemy.tscn",
    attach_to_node: ".",
  });
  out = McpClient.textOf(r);
  check("script_create writes and attaches", /Attached to/.test(out), out);
  check("attachment is in the scene file", /scripts\/enemy\.gd/.test(scene("scenes/enemy.tscn")));

  r = await client.call("script_validate", {});
  out = McpClient.textOf(r);
  check("script_validate passes on a clean project", /no parse errors/.test(out), out);

  r = await client.call("script_create", {
    path: "res://scripts/broken.gd",
    content: "extends Node\nfunc _ready():\n\tvar x: int = \"nope\"\n",
  });
  out = McpClient.textOf(r);
  check("script_create flags a script that will not compile", /does not compile/.test(out), out);

  r = await client.call("script_validate", {});
  out = McpClient.textOf(r);
  check("script_validate reports the failure with a line number", /broken\.gd:3/.test(out), out);
  rmSync(path.join(PROJECT, "scripts/broken.gd"));

  group("Signals");
  r = await client.call("signal_connect", {
    scene: "res://scenes/enemy.tscn",
    from: ".",
    signal: "ready",
    to: ".",
    method: "_on_ready",
  });
  check("signal_connect writes the connection", /\[connection signal="ready"/.test(scene("scenes/enemy.tscn")));

  r = await client.call("signal_connect", {
    scene: "res://scenes/enemy.tscn",
    signal: "no_such_signal",
    method: "_x",
  });
  out = McpClient.textOf(r);
  check("bad signal name is rejected with the valid list", r.isError && /Available signals/.test(out), out);

  group("Visual verification");
  r = await client.call("screenshot", {
    scene: "res://scenes/main.tscn",
    width: 480,
    height: 270,
    background: "#101018",
  });
  const img = McpClient.imageOf(r);
  check("screenshot returns a PNG image", img?.mimeType === "image/png", McpClient.textOf(r));
  check("screenshot has real pixel data", (img?.data?.length ?? 0) > 1000, `${img?.data?.length ?? 0} bytes`);

  // A background colour must not be painted over the scene. A 2D backdrop node
  // draws on top of 3D regardless of z-index, which silently produced a blank
  // frame for every 3D scene.
  const bgOff = McpClient.imageOf(
    await client.call("screenshot", { scene: "res://scenes/world.tscn", width: 480, height: 300 }),
  );
  const bgOn = McpClient.imageOf(
    await client.call("screenshot", {
      scene: "res://scenes/world.tscn", width: 480, height: 300, background: "#101018",
    }),
  );
  check("renders a 3D scene", (bgOff?.data?.length ?? 0) > 2000, `${bgOff?.data?.length ?? 0}`);
  check(
    "background colour does not paint over a 3D scene",
    (bgOn?.data?.length ?? 0) > (bgOff?.data?.length ?? 0) * 0.4,
    `with=${bgOn?.data?.length ?? 0} without=${bgOff?.data?.length ?? 0}`,
  );

  group("Running the project");
  r = await client.call("run_project", { headless: true, wait_seconds: 3 });
  out = McpClient.textOf(r);
  check("run_project runs and returns output", /exit code/.test(out), out);
  check("run_project reports no errors for a clean project", /errors: 0/.test(out), out);
  check(
    "engine shutdown noise is filtered out",
    !/were leaked/.test(out),
    out,
  );

  r = await client.call("get_output", {});
  out = McpClient.textOf(r);
  check("get_output reports session state", /state:/.test(out), out);

  r = await client.call("stop_project", {});
  check("stop_project is safe when nothing runs", !r.isError);

  group("Resources");
  r = await client.call("resource_manage", {
    action: "create",
    path: "res://scenes/bounce.tres",
    type: "PhysicsMaterial",
    properties: { bounce: 0.8, friction: 0.2 },
  });
  check("resource_manage creates a .tres", existsSync(path.join(PROJECT, "scenes/bounce.tres")), McpClient.textOf(r));

  r = await client.call("resource_manage", { action: "read", path: "res://scenes/bounce.tres" });
  out = McpClient.textOf(r);
  check("resource_manage reads values back", /bounce\s+0\.8/.test(out), out);

  r = await client.call("import_assets", { action: "check" });
  check("import_assets reports import state", !r.isError, McpClient.textOf(r));

  r = await client.call("export_project", { action: "list" });
  check("export_project explains missing presets", /export preset/i.test(McpClient.textOf(r)), McpClient.textOf(r));

  group("Security");
  const attacks = [
    ["path traversal via res://", { scene: "res://../../../../etc/passwd" }],
    ["absolute path outside the project", { scene: "/etc/passwd" }],
    ["parent-relative escape", { scene: "../../secrets.tscn" }],
  ];
  for (const [name, args] of attacks) {
    const res = await client.call("scene_tree", args);
    check(`rejects ${name}`, res.isError === true, McpClient.textOf(res));
  }

  const rce = await client.call("node_add", {
    scene: "res://scenes/main.tscn",
    nodes: [{ type: "res://scripts/player.gd", name: "Pwn" }],
  });
  check(
    "rejects a script path used as a node type (arbitrary code execution)",
    rce.isError === true,
    McpClient.textOf(rce),
  );

  const badClass = await client.call("scene_create", {
    scene: "res://scenes/x.tscn",
    root_type: "Node2D; rm -rf /",
  });
  check("rejects a non-identifier class name", badClass.isError === true, McpClient.textOf(badClass));

  const nul = await client.call("scene_tree", { scene: "res://scenes/main .tscn" });
  check("rejects an embedded NUL byte", nul.isError === true, McpClient.textOf(nul));

  group("Live-bridge degradation");
  for (const [name, tool, args] of [
    ["simulate_input", "simulate_input", { kind: "action", action: "jump" }],
    ["runtime_inspect", "runtime_inspect", { what: "state" }],
    ["screenshot(source=game)", "screenshot", { source: "game" }],
  ]) {
    const res = await client.call(tool, args);
    const t = McpClient.textOf(res);
    check(`${name} fails with actionable guidance when no bridge exists`, res.isError && /bridge_install/.test(t), t);
  }

  group("Bridge install");
  r = await client.call("bridge_install", { action: "install" });
  out = McpClient.textOf(r);
  check("bridge_install copies the addon", existsSync(path.join(PROJECT, "addons/godot_assistant/plugin.cfg")), out);
  check(
    "bridge_install enables the plugin in project.godot",
    /addons\/godot_assistant\/plugin\.cfg/.test(scene("project.godot")),
    scene("project.godot"),
  );
  check("project.godot keeps its other settings", /GameState/.test(scene("project.godot")));
  check("project.godot keeps its leading comment", scene("project.godot").startsWith("; Engine"));

  r = await client.call("bridge_install", { action: "status" });
  check("bridge_install status reports installed", /files installed: yes/.test(McpClient.textOf(r)));

  // The addon must not break a normal headless run.
  r = await client.call("run_project", { headless: true, wait_seconds: 3, replace: true });
  out = McpClient.textOf(r);
  check("project still runs cleanly with the addon installed", /errors: 0/.test(out), out);
  check("runtime bridge announces itself", /runtime bridge listening/.test(out), out);

  group("Live bridge (running game)");
  // The whole point of the addon: drive and observe a game while it runs.
  // Windowed, because a headless process has no renderer to screenshot.
  await client.call("run_project", { headless: false, replace: true });
  await new Promise((resolve) => setTimeout(resolve, 4000));

  r = await client.call("runtime_inspect", { what: "state" });
  out = McpClient.textOf(r);
  check("runtime_inspect reads live engine state", !r.isError && /fps:/.test(out), out);
  check("runtime_inspect reports the running scene", /main\.tscn/.test(out), out);

  r = await client.call("runtime_inspect", { what: "tree", max_depth: 3 });
  out = McpClient.textOf(r);
  check("runtime_inspect returns the live tree", !r.isError && /Player \(CharacterBody2D\)/.test(out), out);
  check("live tree includes world positions", /at 1?\d\d/.test(out), out);
  check(
    "live tree descends into instanced scenes (unlike the scene file)",
    /Hitbox/.test(out),
    out,
  );

  r = await client.call("runtime_inspect", {
    what: "node",
    node: "Player",
    properties: ["speed", "jump_force"],
  });
  out = McpClient.textOf(r);
  check("runtime_inspect reads live exported values", /speed = 300/.test(out), out);

  r = await client.call("simulate_input", { kind: "action", action: "jump" });
  check("simulate_input accepts a mapped action", !r.isError, McpClient.textOf(r));

  r = await client.call("simulate_input", { kind: "action", action: "not_a_real_action" });
  out = McpClient.textOf(r);
  check("simulate_input rejects an unmapped action", r.isError && /input action/i.test(out), out);

  r = await client.call("simulate_input", { kind: "click", x: 100, y: 100 });
  check("simulate_input accepts a click", !r.isError, McpClient.textOf(r));

  r = await client.call("screenshot", { source: "game" });
  const liveImg = McpClient.imageOf(r);
  check("screenshot captures the running game", liveImg?.mimeType === "image/png", McpClient.textOf(r));
  check("live screenshot has real pixels", (liveImg?.data?.length ?? 0) > 1000, `${liveImg?.data?.length ?? 0}`);

  await client.call("stop_project", {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  r = await client.call("runtime_inspect", { what: "state" });
  check(
    "runtime tools degrade cleanly once the game stops",
    r.isError && /bridge/i.test(McpClient.textOf(r)),
    McpClient.textOf(r),
  );

  r = await client.call("bridge_install", { action: "uninstall" });
  check("uninstall removes the addon", !existsSync(path.join(PROJECT, "addons/godot_assistant")));
  check(
    "uninstall removes the plugin entry",
    !/godot_assistant\/plugin\.cfg/.test(scene("project.godot")),
    scene("project.godot"),
  );

  group("Read-only mode");
  const ro = new McpClient("node", [entry, "--project", PROJECT, "--read-only"]);
  await ro.initialize();
  const roRead = await ro.call("scene_tree", { scene: "res://scenes/main.tscn" });
  check("read-only still allows reads", !roRead.isError);
  const roWrite = await ro.call("node_add", {
    scene: "res://scenes/main.tscn",
    nodes: [{ type: "Node2D", name: "Nope" }],
  });
  check("read-only refuses writes", roWrite.isError && /read-only/.test(McpClient.textOf(roWrite)));
  ro.close();

  group("Error quality");
  const missing = await client.call("scene_tree", { scene: "res://scenes/nope.tscn" });
  out = McpClient.textOf(missing);
  check("missing scene error names a next step", missing.isError && /scene_create|Check the path/.test(out), out);

  const badNode = await client.call("node_inspect", { scene: "res://scenes/main.tscn", node: "Ghost" });
  out = McpClient.textOf(badNode);
  check("missing node error points at scene_tree", badNode.isError && /scene_tree/.test(out), out);

  const noProject = new McpClient("node", [entry]);
  await noProject.initialize();
  const np = await noProject.call("scene_tree", { scene: "res://x.tscn" });
  out = McpClient.textOf(np);
  check("missing project error explains how to supply one", np.isError && /--project/.test(out), out);
  noProject.close();

  group("Console parsing");
  // Godot 4.3 colourises diagnostics on a non-TTY stdout; 4.7 does not. Without
  // stripping the escapes, a colourised line never matches "SCRIPT ERROR:" and
  // every diagnostic silently degrades into untagged output.
  const { parseGodotOutput } = await import(
    path.resolve(here, "..", "dist", "util", "errors.js")
  );
  const E = "\u001B";
  const coloured = [
    `${E}[1;35mSCRIPT ERROR:${E}[0;95m Parse Error: Cannot assign a value of type "String" as "int".`,
    `${E}[0;90m          at: GDScript::reload (res://brk.gd:3)${E}[0m`,
    `${E}[1;31mERROR:${E}[0;91m Failed to load script "res://brk.gd" with error "Parse error".`,
    `${E}[0;90m   at: load (modules/gdscript/gdscript.cpp:2936)${E}[0m`,
    "hello from the game",
  ].join("\n");
  const parsedColour = parseGodotOutput(coloured);
  check(
    "parses ANSI-colourised diagnostics (Godot 4.3 style)",
    parsedColour.diagnostics.length === 2,
    JSON.stringify(parsedColour.diagnostics),
  );
  check(
    "recovers file and line from a colourised diagnostic",
    parsedColour.diagnostics[0]?.file === "res://brk.gd" && parsedColour.diagnostics[0]?.line === 3,
    JSON.stringify(parsedColour.diagnostics[0]),
  );
  check(
    "leaves plain game output intact",
    parsedColour.output.some((l) => l === "hello from the game"),
    JSON.stringify(parsedColour.output),
  );

  const noisy = parseGodotOutput(
    ["WARNING: 6 RIDs of type \"CanvasItem\" were leaked.", "   at: _free_rids (x.cpp:1)", "real output"].join("\n"),
  );
  check("filters engine shutdown noise", noisy.diagnostics.length === 0, JSON.stringify(noisy.diagnostics));

  const repeated = parseGodotOutput(
    Array(50).fill('ERROR: Node not found: "Ghost".').join("\n"),
  );
  check(
    "collapses a per-frame error into one entry with a count",
    repeated.diagnostics.length === 1 && repeated.diagnostics[0]?.count === 50,
    JSON.stringify(repeated.diagnostics),
  );

  group("Token efficiency");
  const treeOut = McpClient.textOf(await client.call("scene_tree", { scene: "res://scenes/main.tscn" }));
  check(
    `scene_tree output is compact (${treeOut.length} chars for 8 nodes)`,
    treeOut.length < 900,
    treeOut,
  );
  const inspectOut = McpClient.textOf(
    await client.call("node_inspect", { scene: "res://scenes/player.tscn", node: "." }),
  );
  check(
    `node_inspect elides defaults (${inspectOut.length} chars)`,
    inspectOut.length < 2200,
    `${inspectOut.length} chars`,
  );

  client.close();

  process.stdout.write(`\n==================\npassed ${passed}, failed ${failed}\n`);
  if (failed) {
    process.stdout.write(`\nFailures:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  }
  rmSync(PROJECT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`QA harness error: ${error.stack}\n`);
  process.exit(2);
});
