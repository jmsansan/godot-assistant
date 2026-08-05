##
## godot-assistant — editor-side plugin.
##
## Optional. Everything that can be done from the command line works without it;
## this adds the things that genuinely require a live editor: reading what is
## currently open, driving play/stop, and screenshotting the editor itself.
##
@tool
extends EditorPlugin

const BridgeServer := preload("res://addons/godot_assistant/bridge_server.gd")
const RUNTIME_AUTOLOAD := "GodotAssistantRuntime"
const RUNTIME_SCRIPT := "res://addons/godot_assistant/runtime_autoload.gd"
const PREFERRED_PORT := 0  # OS-assigned; several projects can be open at once.

var _bridge: Node


func _enter_tree() -> void:
	_bridge = BridgeServer.new()
	_bridge.name = "GodotAssistantBridge"
	add_child(_bridge)
	_bridge.command_received.connect(_on_command)

	var started: Dictionary = _bridge.start("editor", PREFERRED_PORT)
	if started.get("ok", false):
		print("[godot-assistant] editor bridge listening on 127.0.0.1:%d" % started.get("port", 0))
	else:
		push_warning("[godot-assistant] could not start the editor bridge: %s" % started.get("error", "unknown"))

	# The runtime autoload (which is what lets a *running game* be inspected) is
	# registered by `bridge_install` writing directly to project.godot, not
	# here. Doing it from the plugin would mean the runtime bridge only ever
	# existed after the editor had been opened once, and games launched straight
	# from the command line would silently lack it.
	if not ProjectSettings.has_setting("autoload/%s" % RUNTIME_AUTOLOAD):
		add_autoload_singleton(RUNTIME_AUTOLOAD, RUNTIME_SCRIPT)


func _exit_tree() -> void:
	if _bridge != null:
		_bridge.stop()
		_bridge.queue_free()
		_bridge = null


func _on_command(command: String, params: Dictionary, responder: Callable) -> void:
	responder.call(_execute(command, params))


func _execute(command: String, p: Dictionary) -> Dictionary:
	match command:
		"ping":
			return {"ok": true, "role": "editor", "godot": Engine.get_version_info()["string"]}
		"state":
			return _state()
		"open_scene":
			return _open_scene(str(p.get("path", "")))
		"save_scene":
			return _save_scene()
		"reload_scene":
			EditorInterface.reload_scene_from_path(_current_scene_path())
			return {"ok": true, "reloaded": _current_scene_path()}
		"play":
			EditorInterface.play_main_scene()
			return {"ok": true, "playing": "main scene"}
		"play_scene":
			var path_value := str(p.get("path", ""))
			if path_value == "":
				return {"ok": false, "error": "play_scene needs a scene path."}
			if not FileAccess.file_exists(path_value):
				return {"ok": false, "error": "Scene not found: %s" % path_value}
			EditorInterface.play_custom_scene(path_value)
			return {"ok": true, "playing": path_value}
		"stop":
			EditorInterface.stop_playing_scene()
			return {"ok": true, "stopped": true}
		"is_playing":
			return {"ok": true, "playing": EditorInterface.is_playing_scene()}
		"select":
			return _select(str(p.get("node", "")))
		"selection":
			return _selection()
		"screenshot":
			return _screenshot(str(p.get("out", "")))
		"rescan":
			EditorInterface.get_resource_filesystem().scan()
			return {"ok": true, "rescanning": true}
		"reimport":
			var files: Array = p.get("files", [])
			var as_strings := PackedStringArray()
			for f in files:
				as_strings.append(str(f))
			EditorInterface.get_resource_filesystem().reimport_files(as_strings)
			return {"ok": true, "reimported": as_strings.size()}
		_:
			return {"ok": false, "error": "Unknown editor command: %s" % command}


func _current_scene_path() -> String:
	var scene := EditorInterface.get_edited_scene_root()
	return scene.scene_file_path if scene != null else ""


func _state() -> Dictionary:
	var open_scenes: Array = []
	for path_value in EditorInterface.get_open_scenes():
		open_scenes.append(str(path_value))
	var root := EditorInterface.get_edited_scene_root()
	return {
		"ok": true,
		"current_scene": _current_scene_path(),
		"current_root": root.name if root != null else "",
		"open_scenes": open_scenes,
		"playing": EditorInterface.is_playing_scene(),
		"selection": _selected_paths(),
		"godot": Engine.get_version_info()["string"],
	}


func _selected_paths() -> Array:
	var out: Array = []
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return out
	for node in EditorInterface.get_selection().get_selected_nodes():
		out.append(str(root.get_path_to(node)))
	return out


func _selection() -> Dictionary:
	return {"ok": true, "selection": _selected_paths()}


func _open_scene(path_value: String) -> Dictionary:
	if path_value == "":
		return {"ok": false, "error": "open_scene needs a scene path."}
	if not FileAccess.file_exists(path_value):
		return {"ok": false, "error": "Scene not found: %s" % path_value}
	EditorInterface.open_scene_from_path(path_value)
	return {"ok": true, "opened": path_value}


func _save_scene() -> Dictionary:
	var path_value := _current_scene_path()
	if path_value == "":
		return {"ok": false, "error": "No scene is currently open in the editor."}
	var err := EditorInterface.save_scene()
	if err != OK:
		return {"ok": false, "error": "Editor failed to save the scene (error %d)." % err}
	return {"ok": true, "saved": path_value}


func _select(node_path: String) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"ok": false, "error": "No scene is open in the editor."}
	var node := root.get_node_or_null(NodePath(node_path)) if node_path != "." else root
	if node == null:
		return {"ok": false, "error": "Node not found in the open scene: %s" % node_path}
	var selection := EditorInterface.get_selection()
	selection.clear()
	selection.add_node(node)
	return {"ok": true, "selected": node_path}


## Captures the editor window itself, which is what an agent needs in order to
## check layout, docked panels, or what the 2D/3D viewport is showing.
func _screenshot(out_path: String) -> Dictionary:
	if out_path == "":
		return {"ok": false, "error": "screenshot needs an output path."}
	var viewport := EditorInterface.get_base_control().get_viewport()
	if viewport == null:
		return {"ok": false, "error": "Editor viewport unavailable."}
	var texture := viewport.get_texture()
	if texture == null:
		return {"ok": false, "error": "Editor render target unavailable."}
	var image := texture.get_image()
	if image == null:
		return {"ok": false, "error": "Could not read the editor frame."}
	var err := image.save_png(out_path)
	if err != OK:
		return {"ok": false, "error": "Failed to write PNG (error %d)." % err}
	return {"ok": true, "path": out_path, "width": image.get_width(), "height": image.get_height()}
