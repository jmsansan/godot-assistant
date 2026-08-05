##
## godot-assistant — runtime autoload.
##
## Registered automatically when the plugin is enabled. It gives an agent the
## one thing static analysis can never provide: the ability to look at the game
## while it is actually running — the live node tree, real property values,
## a rendered frame, and synthetic input.
##
## Inactive unless the plugin is enabled, and it listens on loopback with a
## per-session token. It removes itself from exported builds by refusing to
## start outside a debug build.
##
extends Node

const BridgeServer := preload("res://addons/godot_assistant/bridge_server.gd")

var _bridge: Node


func _ready() -> void:
	# Never open a socket in a shipped game. A released build has no business
	# listening for anything, and this autoload survives export otherwise.
	if not OS.is_debug_build():
		return

	process_mode = Node.PROCESS_MODE_ALWAYS  # keep responding while paused
	_bridge = BridgeServer.new()
	_bridge.name = "GodotAssistantRuntimeBridge"
	add_child(_bridge)
	_bridge.command_received.connect(_on_command)

	var started: Dictionary = _bridge.start("runtime", 0)
	if started.get("ok", false):
		print("[godot-assistant] runtime bridge listening on 127.0.0.1:%d" % started.get("port", 0))


func _exit_tree() -> void:
	if _bridge != null:
		_bridge.stop()


func _on_command(command: String, params: Dictionary, responder: Callable) -> void:
	match command:
		"screenshot":
			_screenshot(params, responder)
		_:
			responder.call(_execute(command, params))


func _execute(command: String, p: Dictionary) -> Dictionary:
	match command:
		"ping":
			return {"ok": true, "role": "runtime", "scene": _scene_path(), "fps": Engine.get_frames_per_second()}
		"tree":
			return _tree(p)
		"inspect":
			return _inspect(p)
		"set_property":
			return _set_property(p)
		"call_method":
			return _call_method(p)
		"input":
			return _simulate_input(p)
		"pause":
			get_tree().paused = true
			return {"ok": true, "paused": true}
		"resume":
			get_tree().paused = false
			return {"ok": true, "paused": false}
		"state":
			return _state()
		"quit":
			get_tree().quit()
			return {"ok": true, "quitting": true}
		_:
			return {"ok": false, "error": "Unknown runtime command: %s" % command}


func _scene_path() -> String:
	var current := get_tree().current_scene
	return current.scene_file_path if current != null else ""


func _state() -> Dictionary:
	return {
		"ok": true,
		"scene": _scene_path(),
		"paused": get_tree().paused,
		"fps": Engine.get_frames_per_second(),
		"nodes": get_tree().get_node_count(),
		"time": Time.get_ticks_msec() / 1000.0,
		"memory_mb": snappedf(float(OS.get_static_memory_usage()) / 1048576.0, 0.1),
		"window": [get_window().size.x, get_window().size.y],
	}


func _root_for(p: Dictionary) -> Node:
	# Default to the current scene rather than /root so paths line up with what
	# scene_tree reports for the same file.
	var from := str(p.get("from", ""))
	if from == "/root":
		return get_tree().root
	return get_tree().current_scene


func _resolve(p: Dictionary, key: String = "node") -> Node:
	var root := _root_for(p)
	if root == null:
		return null
	var node_path := str(p.get(key, "."))
	if node_path == "." or node_path == "":
		return root
	return root.get_node_or_null(NodePath(node_path))


func _tree(p: Dictionary) -> Dictionary:
	var root := _root_for(p)
	if root == null:
		return {"ok": false, "error": "No scene is currently running."}
	var start := _resolve(p)
	if start == null:
		return {"ok": false, "error": "Node not found: %s" % p.get("node", ".")}
	var max_depth := int(p.get("max_depth", 6))
	return {"ok": true, "scene": _scene_path(), "tree": _describe(start, root, 0, max_depth)}


func _describe(node: Node, root: Node, depth: int, max_depth: int) -> Dictionary:
	var entry := {"name": node.name, "type": node.get_class()}
	if node is Node2D:
		var n2 := node as Node2D
		entry["pos"] = [snappedf(n2.global_position.x, 0.01), snappedf(n2.global_position.y, 0.01)]
		entry["visible"] = n2.visible
	elif node is Node3D:
		var n3 := node as Node3D
		var gp := n3.global_position
		entry["pos"] = [snappedf(gp.x, 0.01), snappedf(gp.y, 0.01), snappedf(gp.z, 0.01)]
		entry["visible"] = n3.visible
	elif node is Control:
		var c := node as Control
		entry["rect"] = [
			snappedf(c.global_position.x, 0.01), snappedf(c.global_position.y, 0.01),
			snappedf(c.size.x, 0.01), snappedf(c.size.y, 0.01),
		]
		entry["visible"] = c.visible
		if node is Label:
			entry["text"] = (node as Label).text
		elif node is Button:
			entry["text"] = (node as Button).text

	if node.get_child_count() > 0:
		if depth < max_depth:
			var children: Array = []
			for child in node.get_children():
				children.append(_describe(child, root, depth + 1, max_depth))
			entry["children"] = children
		else:
			entry["truncated_children"] = node.get_child_count()
	return entry


func _inspect(p: Dictionary) -> Dictionary:
	var node := _resolve(p)
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % p.get("node", ".")}

	var only: Array = p.get("properties", [])
	var props: Array = []
	for entry in node.get_property_list():
		var usage := int(entry.get("usage", 0))
		if not (usage & PROPERTY_USAGE_EDITOR):
			continue
		if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
			continue
		var name := str(entry.get("name", ""))
		if name == "":
			continue
		if not only.is_empty() and not only.has(name):
			continue
		props.append({"name": name, "value": _stringify(node.get(name))})

	return {
		"ok": true,
		"node": str(p.get("node", ".")),
		"type": node.get_class(),
		"groups": node.get_groups().map(func(g): return str(g)),
		"properties": props,
	}


func _stringify(value: Variant) -> String:
	match typeof(value):
		TYPE_OBJECT:
			if value == null:
				return "null"
			if value is Resource and (value as Resource).resource_path != "":
				return (value as Resource).resource_path
			return "<%s>" % (value as Object).get_class()
		TYPE_NIL:
			return "null"
		_:
			return str(value)


func _set_property(p: Dictionary) -> Dictionary:
	var node := _resolve(p)
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % p.get("node", ".")}
	var name := str(p.get("property", ""))
	if name == "":
		return {"ok": false, "error": "set_property needs 'property'."}
	var before: Variant = node.get(name)
	node.set(name, p.get("value"))
	return {"ok": true, "node": str(p.get("node", ".")), "property": name,
		"before": _stringify(before), "after": _stringify(node.get(name))}


func _call_method(p: Dictionary) -> Dictionary:
	var node := _resolve(p)
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % p.get("node", ".")}
	var method := str(p.get("method", ""))
	if method == "":
		return {"ok": false, "error": "call_method needs 'method'."}
	if not node.has_method(method):
		return {"ok": false, "error": "%s has no method '%s'." % [node.get_class(), method]}
	var args: Array = p.get("args", [])
	var result: Variant = node.callv(method, args)
	return {"ok": true, "result": _stringify(result)}


## Synthetic input. Goes through Input.parse_input_event so the game's own
## _input/_unhandled_input and Input.is_action_pressed all react exactly as they
## would to a real device.
## Named _simulate_input rather than _input: Node already declares a virtual
## _input(InputEvent), and a same-named method with a different signature is a
## parse error that stops the whole autoload from loading.
func _simulate_input(p: Dictionary) -> Dictionary:
	var kind := str(p.get("kind", ""))
	match kind:
		"action":
			var action := str(p.get("action", ""))
			if action == "":
				return {"ok": false, "error": "input action needs 'action'."}
			if not InputMap.has_action(action):
				return {"ok": false, "error": "No such input action: %s" % action,
					"hint": "Check project_info for the project's input map."}
			var strength := float(p.get("strength", 1.0))
			if bool(p.get("pressed", true)):
				Input.action_press(action, strength)
			else:
				Input.action_release(action)
			return {"ok": true, "action": action, "pressed": bool(p.get("pressed", true))}
		"key":
			var event := InputEventKey.new()
			var key_name := str(p.get("key", ""))
			var keycode := OS.find_keycode_from_string(key_name)
			if keycode == KEY_NONE:
				return {"ok": false, "error": "Unrecognised key: %s" % key_name,
					"hint": "Use names such as A, Space, Escape, Enter, Left, F1."}
			event.keycode = keycode
			event.physical_keycode = keycode
			event.pressed = bool(p.get("pressed", true))
			event.shift_pressed = bool(p.get("shift", false))
			event.ctrl_pressed = bool(p.get("ctrl", false))
			event.alt_pressed = bool(p.get("alt", false))
			Input.parse_input_event(event)
			return {"ok": true, "key": key_name, "pressed": event.pressed}
		"mouse_move":
			var move := InputEventMouseMotion.new()
			var pos := Vector2(float(p.get("x", 0)), float(p.get("y", 0)))
			move.position = pos
			move.global_position = pos
			move.relative = Vector2(float(p.get("dx", 0)), float(p.get("dy", 0)))
			Input.parse_input_event(move)
			return {"ok": true, "moved_to": [pos.x, pos.y]}
		"mouse_button", "click":
			var click := InputEventMouseButton.new()
			var at := Vector2(float(p.get("x", 0)), float(p.get("y", 0)))
			click.position = at
			click.global_position = at
			click.button_index = int(p.get("button", MOUSE_BUTTON_LEFT))
			click.double_click = bool(p.get("double", false))
			# A click is press + release; sending only the press leaves the game
			# in a stuck-button state that is confusing to debug.
			click.pressed = true
			Input.parse_input_event(click)
			if kind == "click":
				var up := click.duplicate() as InputEventMouseButton
				up.pressed = false
				Input.parse_input_event(up)
			else:
				click.pressed = bool(p.get("pressed", true))
			return {"ok": true, "clicked_at": [at.x, at.y], "button": click.button_index}
		_:
			return {"ok": false, "error": "Unknown input kind: %s" % kind,
				"hint": "Use action, key, mouse_move, mouse_button or click."}


## Captures the live frame. Must wait for a post-draw so the image is the frame
## the player would actually be looking at.
func _screenshot(p: Dictionary, responder: Callable) -> void:
	var out_path := str(p.get("out", ""))
	if out_path == "":
		responder.call({"ok": false, "error": "screenshot needs an output path."})
		return

	# Let any pending input settle into a rendered frame first.
	var settle := clampi(int(p.get("settle_frames", 2)), 0, 120)
	for i in settle:
		await get_tree().process_frame

	# Bounded rather than a bare `await RenderingServer.frame_post_draw`: an
	# occluded or minimised window is throttled by the OS and may not draw at
	# all, which would hang this call until the client's timeout. Capturing a
	# slightly stale frame beats returning nothing, so note it and carry on.
	var fresh := await _wait_for_draw(3.0)

	var texture := get_viewport().get_texture()
	if texture == null:
		responder.call({"ok": false, "error": "No render target (is the game running headless?)."})
		return
	var image := texture.get_image()
	if image == null:
		responder.call({"ok": false, "error": "Could not read the rendered frame."})
		return
	var err := image.save_png(out_path)
	if err != OK:
		responder.call({"ok": false, "error": "Failed to write PNG (error %d)." % err})
		return
	var result := {"ok": true, "path": out_path, "width": image.get_width(),
		"height": image.get_height(), "scene": _scene_path()}
	if not fresh:
		result["note"] = "The window did not draw a new frame within 3s (it may be minimised, occluded or unfocused), so this may be a stale frame."
	responder.call(result)


## Waits for the renderer to finish a frame, giving up after `timeout` seconds.
## Returns whether a real draw happened.
func _wait_for_draw(timeout: float) -> bool:
	var drawn := [false]
	var on_draw := func() -> void:
		drawn[0] = true
	RenderingServer.frame_post_draw.connect(on_draw, CONNECT_ONE_SHOT)

	var deadline := Time.get_ticks_msec() + int(timeout * 1000.0)
	while not drawn[0] and Time.get_ticks_msec() < deadline:
		# process_always so this still ticks while the game is paused.
		await get_tree().create_timer(0.05, true, false, true).timeout

	if RenderingServer.frame_post_draw.is_connected(on_draw):
		RenderingServer.frame_post_draw.disconnect(on_draw)
	return drawn[0]
