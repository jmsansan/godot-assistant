#!/usr/bin/env -S godot --headless --script
##
## godot-assistant — engine-side operation dispatcher.
##
## Run by the MCP server as:
##   godot --headless --path <project> --script <abs>/ops.gd -- '{"op":...,"params":{...}}'
##
## This file is passed by absolute path from outside the project, so running an
## operation never adds files to the user's project.
##
## Contract: exactly one JSON object is printed between the sentinels below.
## The engine writes plenty of unrelated text to stdout, so sentinels are the
## only dependable framing.
##
extends SceneTree

const BEGIN := "<<<GODOT_ASSISTANT_RESULT"
const END := "GODOT_ASSISTANT_RESULT>>>"

## Temp suffix used for the write-verify-commit cycle on scene saves.
const TMP_SUFFIX := ".gassist-tmp.tscn"

var _warnings: Array[String] = []


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		_fail("No operation payload supplied.")
		return

	var parsed: Variant = JSON.parse_string(args[0])
	if typeof(parsed) != TYPE_DICTIONARY:
		_fail("Operation payload is not a JSON object.")
		return

	var payload: Dictionary = parsed
	var op := str(payload.get("op", ""))
	var params: Dictionary = payload.get("params", {})

	var result: Dictionary = _dispatch(op, params)
	if not _warnings.is_empty() and result.get("ok", false):
		result["warnings"] = _warnings
	_emit(result)


func _dispatch(op: String, p: Dictionary) -> Dictionary:
	match op:
		"ping": return {"ok": true, "version": Engine.get_version_info()}
		"project_stats": return _project_stats(p)
		"list_files": return _list_files(p)
		"search": return _search(p)
		"scene_tree": return _scene_tree(p)
		"scene_create": return _scene_create(p)
		"node_add": return _node_add(p)
		"node_modify": return _node_modify(p)
		"node_inspect": return _node_inspect(p)
		"scene_instance": return _scene_instance(p)
		"signal_edit": return _signal_edit(p)
		"script_create": return _script_create(p)
		"validate_scripts": return _validate_scripts(p)
		"api_reference": return _api_reference(p)
		"resource_create": return _resource_create(p)
		"resource_read": return _resource_read(p)
		"resource_edit": return _resource_edit(p)
		"import_status": return _import_status(p)
		"export_presets": return _export_presets(p)
		"uid_get": return _uid_get(p)
		_: return _err("Unknown operation: %s" % op)


# ---------------------------------------------------------------------------
# Result plumbing
# ---------------------------------------------------------------------------

func _emit(result: Dictionary) -> void:
	print(BEGIN)
	print(JSON.stringify(result))
	print(END)
	quit(0)


func _fail(message: String) -> void:
	_emit({"ok": false, "error": message})


func _err(message: String, hint: String = "") -> Dictionary:
	var out := {"ok": false, "error": message}
	if hint != "":
		out["hint"] = hint
	return out


func _warn(message: String) -> void:
	if not _warnings.has(message):
		_warnings.append(message)


# ---------------------------------------------------------------------------
# Path helpers
#
# The server already confines paths to the project, but the engine side
# re-validates: defence in depth costs nothing here and this script is also
# usable standalone.
# ---------------------------------------------------------------------------

func _res(path_value: String) -> String:
	var p := path_value.strip_edges()
	if p.begins_with("res://"):
		return p
	if p.begins_with("user://"):
		return p
	return "res://" + p.trim_prefix("/")


func _safe_res(path_value: String) -> String:
	var p := _res(path_value)
	# Reject traversal and any control character (strip_escapes removes
	# non-printables, so a difference means one was present). Spaces are legal
	# in Godot paths — asset folders routinely contain them — so they stay.
	if p.contains("..") or p != p.strip_escapes():
		return ""
	return p


# ---------------------------------------------------------------------------
# Class + property validation
# ---------------------------------------------------------------------------

## Resolves a node type name to an instance, rejecting anything that is not a
## real, instantiable engine class.
##
## This is the guard against passing a script path as a "type": doing so would
## otherwise reach load() and execute arbitrary GDScript inside this process.
func _instantiate_class(type_name: String) -> Variant:
	var clean := type_name.strip_edges()
	if not clean.is_valid_identifier():
		return null
	if not ClassDB.class_exists(clean):
		return null
	if not ClassDB.can_instantiate(clean):
		return null
	if not ClassDB.is_parent_class(clean, "Node"):
		return null
	return ClassDB.instantiate(clean)


func _class_suggestions(type_name: String) -> Array:
	var lowered := type_name.to_lower()
	var hits: Array = []
	for candidate in ClassDB.get_class_list():
		var c := str(candidate)
		if c.to_lower().contains(lowered) or lowered.contains(c.to_lower()):
			if ClassDB.is_parent_class(c, "Node"):
				hits.append(c)
		if hits.size() >= 8:
			break
	hits.sort()
	return hits


## Coerces a JSON value into the type Godot expects for `property` on `target`.
##
## JSON has no Vector2, Color or NodePath, so every structured property arrives
## as an array, string or dictionary and has to be rebuilt.
func _coerce(target: Object, property: String, value: Variant) -> Variant:
	var expected := TYPE_NIL
	for entry in _all_properties(target):
		if str(entry.get("name", "")) == property:
			expected = int(entry.get("type", TYPE_NIL))
			break

	# A res:// string for an object-typed property means "load this resource".
	if expected == TYPE_OBJECT and typeof(value) == TYPE_STRING:
		var path_value := str(value)
		if path_value.begins_with("res://"):
			if not ResourceLoader.exists(path_value):
				_warn("Resource not found, property '%s' left unset: %s" % [property, path_value])
				return null
			return load(path_value)
		if path_value == "":
			return null

	match expected:
		TYPE_VECTOR2: return _to_vec2(value)
		TYPE_VECTOR2I:
			var v2 = _to_vec2(value)
			return Vector2i(v2) if v2 != null else null
		TYPE_VECTOR3: return _to_vec3(value)
		TYPE_VECTOR3I:
			var v3 = _to_vec3(value)
			return Vector3i(v3) if v3 != null else null
		TYPE_VECTOR4: return _to_vec4(value)
		TYPE_COLOR: return _to_color(value)
		TYPE_RECT2:
			var a := _to_array(value)
			if a.size() == 4:
				return Rect2(a[0], a[1], a[2], a[3])
		TYPE_RECT2I:
			var a := _to_array(value)
			if a.size() == 4:
				return Rect2i(a[0], a[1], a[2], a[3])
		TYPE_NODE_PATH: return NodePath(str(value))
		TYPE_STRING_NAME: return StringName(str(value))
		TYPE_QUATERNION:
			var a := _to_array(value)
			if a.size() == 4:
				return Quaternion(a[0], a[1], a[2], a[3])
		TYPE_TRANSFORM2D:
			var a := _to_array(value)
			if a.size() == 6:
				return Transform2D(Vector2(a[0], a[1]), Vector2(a[2], a[3]), Vector2(a[4], a[5]))
		TYPE_INT:
			return int(value) if typeof(value) != TYPE_STRING else _enum_value(target, property, str(value))
		TYPE_FLOAT: return float(value)
		TYPE_BOOL: return bool(value)
		TYPE_STRING: return str(value)

	if expected != TYPE_NIL:
		return type_convert(value, expected)
	return value


## Lets an integer property be set by enum constant name, e.g. "MOUSE_FILTER_IGNORE".
func _enum_value(target: Object, property: String, value: String) -> Variant:
	if value.is_valid_int():
		return int(value)
	var cls := target.get_class()
	while cls != "":
		var constants := ClassDB.class_get_integer_constant_list(cls, true)
		for c in constants:
			if str(c) == value:
				return ClassDB.class_get_integer_constant(cls, StringName(value))
		cls = ClassDB.get_parent_class(cls)
	_warn("Could not interpret '%s' for property '%s'; passing through as int 0." % [value, property])
	return 0


func _to_array(value: Variant) -> Array:
	if typeof(value) == TYPE_ARRAY:
		return value
	if typeof(value) == TYPE_DICTIONARY:
		var d: Dictionary = value
		var out: Array = []
		for key in ["x", "y", "z", "w"]:
			if d.has(key):
				out.append(float(d[key]))
		return out
	return []


func _to_vec2(value: Variant) -> Variant:
	var a := _to_array(value)
	if a.size() >= 2:
		return Vector2(float(a[0]), float(a[1]))
	if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
		return Vector2(float(value), float(value))
	return null


func _to_vec3(value: Variant) -> Variant:
	var a := _to_array(value)
	if a.size() >= 3:
		return Vector3(float(a[0]), float(a[1]), float(a[2]))
	if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
		return Vector3(float(value), float(value), float(value))
	return null


func _to_vec4(value: Variant) -> Variant:
	var a := _to_array(value)
	if a.size() >= 4:
		return Vector4(float(a[0]), float(a[1]), float(a[2]), float(a[3]))
	return null


func _to_color(value: Variant) -> Variant:
	if typeof(value) == TYPE_STRING:
		return Color(str(value)) if not str(value).begins_with("#") else Color.html(str(value))
	var a := _to_array(value)
	if a.size() >= 3:
		return Color(float(a[0]), float(a[1]), float(a[2]), float(a[3]) if a.size() > 3 else 1.0)
	return null


func _all_properties(target: Object) -> Array:
	return target.get_property_list()


# ---------------------------------------------------------------------------
# Scene loading and saving
#
# Editing an existing scene is the highest-risk thing this server does: a bad
# save silently corrupts a file the user may not look at for hours. The cycle is
# therefore load -> verify preconditions -> edit -> write temp -> verify the
# result -> commit, and it refuses rather than degrading the file.
# ---------------------------------------------------------------------------

class SceneHandle:
	var root: Node
	var path: String
	var original_text: String
	var uid: String = ""

	func free_tree() -> void:
		if is_instance_valid(root):
			root.free()


func _load_scene(scene_path: String) -> Variant:
	var p := _safe_res(scene_path)
	if p == "":
		return _err("Invalid scene path: %s" % scene_path)
	if not FileAccess.file_exists(p):
		return _err("Scene not found: %s" % p, "Check the path, or create it with scene_create.")

	var text := ""
	var f := FileAccess.open(p, FileAccess.READ)
	if f != null:
		text = f.get_as_text()
		f.close()

	# A C# script reference cannot be resolved by a non-.NET build. The load
	# succeeds with a null script and the attachment is lost on save, so this is
	# refused up front rather than detected afterwards.
	if _has_csharp_refs(text) and not _is_dotnet_build():
		return _err(
			"Scene %s references C# scripts, but this Godot build has no .NET support." % p,
			"Editing it here would drop those script attachments. Install the .NET/Mono build of Godot and set GODOT_PATH to it, or edit this scene by hand."
		)

	var packed: Resource = ResourceLoader.load(p, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if packed == null or not (packed is PackedScene):
		return _err("Could not load scene: %s" % p, "The file may be corrupt or reference a resource that fails to load. Run script_validate.")

	# GEN_EDIT_STATE_INSTANCE keeps instanced-subscene overrides and exported
	# property values intact; the default state discards them.
	var inst: Node = (packed as PackedScene).instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	if inst == null:
		return _err("Could not instantiate scene: %s" % p)

	var handle := SceneHandle.new()
	handle.root = inst
	handle.path = p
	handle.original_text = text
	handle.uid = _extract_uid(text)
	return handle


func _has_csharp_refs(text: String) -> bool:
	return text.contains(".cs\"") or text.contains("type=\"CSharpScript\"")


func _is_dotnet_build() -> bool:
	return ClassDB.class_exists("CSharpScript")


## Pulls uid="uid://..." out of the [gd_scene] header.
func _extract_uid(text: String) -> String:
	var re := RegEx.new()
	re.compile("\\[gd_scene[^\\]]*uid=\"(uid://[^\"]+)\"")
	var m := re.search(text)
	return m.get_string(1) if m != null else ""


## Packs and writes a scene, preserving its UID and refusing lossy saves.
##
## `expect_scripts` carries the script resource paths seen before editing; if any
## disappear, the write is abandoned. Losing a script reference is the failure
## mode that quietly breaks a project.
func _save_scene(handle: SceneHandle, allow_script_loss: bool = false) -> Dictionary:
	var packed := PackedScene.new()
	var pack_err := packed.pack(handle.root)
	if pack_err != OK:
		return _err("Failed to pack scene: error %d" % pack_err)

	var tmp_path := handle.path.trim_suffix(".tscn") + TMP_SUFFIX
	var save_err := ResourceSaver.save(packed, tmp_path)
	if save_err != OK:
		return _err("Failed to write scene: error %d" % save_err)

	var f := FileAccess.open(tmp_path, FileAccess.READ)
	if f == null:
		return _err("Could not read back the written scene.")
	var new_text := f.get_as_text()
	f.close()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(tmp_path))

	# Re-attach the UID. ResourceSaver does not carry it over, and dropping it
	# breaks every other scene that references this one by uid://.
	if handle.uid != "" and not new_text.contains(handle.uid):
		new_text = new_text.replace("[gd_scene ", "[gd_scene uid=\"%s\" " % handle.uid, )
		# Guard against the no-attribute form "[gd_scene]".
		if not new_text.contains(handle.uid):
			new_text = new_text.replace("[gd_scene]", "[gd_scene uid=\"%s\"]" % handle.uid)

	if handle.original_text != "":
		var lost := _lost_scripts(handle.original_text, new_text)
		if not lost.is_empty():
			if not allow_script_loss:
				return _err(
					"Refusing to save: %d script reference(s) would be lost: %s" % [lost.size(), ", ".join(lost)],
					"This usually means a script failed to load in headless mode. Fix the script (script_validate), or pass force=true if the removal is intentional."
				)
			_warn("Script references removed: %s" % ", ".join(lost))

	var out := FileAccess.open(handle.path, FileAccess.WRITE)
	if out == null:
		return _err("Cannot write to %s" % handle.path, "Check file permissions.")
	out.store_string(new_text)
	out.close()
	return {"ok": true}


## Script ext_resource paths present before the edit but absent after it.
func _lost_scripts(before: String, after: String) -> Array:
	var re := RegEx.new()
	re.compile("\\[ext_resource type=\"Script\"[^\\]]*path=\"([^\"]+)\"")
	var lost: Array = []
	for m in re.search_all(before):
		var p := m.get_string(1)
		if not after.contains("\"%s\"" % p):
			lost.append(p)
	return lost


## Writes a brand-new scene, assigning a fresh UID so references are stable.
func _write_new_scene(root: Node, path_value: String) -> Dictionary:
	var packed := PackedScene.new()
	var pack_err := packed.pack(root)
	if pack_err != OK:
		return _err("Failed to pack scene: error %d" % pack_err)

	var dir := path_value.get_base_dir()
	if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(dir)):
		DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(dir))

	var save_err := ResourceSaver.save(packed, path_value)
	if save_err != OK:
		return _err("Failed to save scene to %s: error %d" % [path_value, save_err])

	# Give the new scene a UID so other scenes can reference it stably.
	var uid_id := ResourceUID.create_id()
	var uid_text := ResourceUID.id_to_text(uid_id)
	var f := FileAccess.open(path_value, FileAccess.READ)
	if f != null:
		var text := f.get_as_text()
		f.close()
		if not text.contains("uid://"):
			text = text.replace("[gd_scene ", "[gd_scene uid=\"%s\" " % uid_text)
			if not text.contains("uid://"):
				text = text.replace("[gd_scene]", "[gd_scene uid=\"%s\"]" % uid_text)
			var w := FileAccess.open(path_value, FileAccess.WRITE)
			if w != null:
				w.store_string(text)
				w.close()
		ResourceUID.add_id(uid_id, path_value)
	return {"ok": true, "uid": uid_text}


## Every descendant must have `owner` set to the scene root or it is not saved.
func _adopt(node: Node, owner_root: Node) -> void:
	if node != owner_root:
		node.owner = owner_root
	for child in node.get_children():
		_adopt(child, owner_root)


## True for connections the user authored, i.e. the ones stored in the .tscn.
##
## Containers and other engine classes wire up a pile of internal connections
## (queue_sort, _child_minsize_changed, …) at instantiation. They are noise, and
## they bury the handful of connections someone actually asked about.
## CONNECT_PERSIST is precisely the flag that marks a connection as saved.
func _is_authored(connection: Dictionary) -> bool:
	return int(connection.get("flags", 0)) & CONNECT_PERSIST != 0


## Flattens a scene into a list, used for reverse lookups such as "which nodes
## connect *to* this one".
func _all_nodes(root: Node) -> Array:
	var out: Array = [root]
	for child in root.get_children():
		out.append_array(_all_nodes(child))
	return out


func _find_node(root: Node, node_path: String) -> Node:
	if node_path == "." or node_path == "":
		return root
	return root.get_node_or_null(NodePath(node_path))


# ---------------------------------------------------------------------------
# Operations: project + files
# ---------------------------------------------------------------------------

func _project_stats(_p: Dictionary) -> Dictionary:
	var counts := {"scenes": 0, "scripts": 0, "resources": 0, "images": 0, "audio": 0, "models": 0, "other": 0}
	var files := _walk("res://", counts)
	return {
		"ok": true,
		"counts": counts,
		"total_files": files.size(),
		"dotnet_build": _is_dotnet_build(),
		"engine": Engine.get_version_info(),
	}


const SKIP_DIRS := [".godot", ".git", ".import", "node_modules", ".svn", ".venv"]

func _walk(dir_path: String, counts: Dictionary) -> Array:
	var found: Array = []
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return found
	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if name.begins_with("."):
			name = dir.get_next()
			continue
		var full := dir_path.path_join(name)
		if dir.current_is_dir():
			if not SKIP_DIRS.has(name):
				found.append_array(_walk(full, counts))
		else:
			found.append(full)
			var key := _classify(name)
			counts[key] = int(counts.get(key, 0)) + 1
		name = dir.get_next()
	dir.list_dir_end()
	return found


func _classify(name: String) -> String:
	var ext := name.get_extension().to_lower()
	match ext:
		"tscn", "scn": return "scenes"
		"gd", "cs", "gdshader": return "scripts"
		"tres", "res", "theme": return "resources"
		"png", "jpg", "jpeg", "svg", "webp", "bmp", "tga", "ktx": return "images"
		"ogg", "wav", "mp3": return "audio"
		"glb", "gltf", "obj", "fbx", "blend", "dae": return "models"
		"import", "uid": return "other"
		_: return "other"


func _list_files(p: Dictionary) -> Dictionary:
	var root_dir := _safe_res(str(p.get("dir", "res://")))
	if root_dir == "":
		return _err("Invalid directory.")
	var kind := str(p.get("kind", "all"))
	var pattern := str(p.get("pattern", ""))

	var counts := {}
	var all := _walk(root_dir, counts)
	var out: Array = []
	for entry in all:
		var path_value := str(entry)
		if path_value.ends_with(".import") or path_value.ends_with(".uid"):
			continue
		if kind != "all" and _classify(path_value.get_file()) != kind:
			continue
		if pattern != "" and not path_value.get_file().matchn(pattern) and not path_value.matchn(pattern):
			continue
		out.append(path_value)
	out.sort()
	return {"ok": true, "files": out}


func _search(p: Dictionary) -> Dictionary:
	var query := str(p.get("query", ""))
	if query == "":
		return _err("Empty search query.")
	var kind := str(p.get("kind", "all"))
	var case_sensitive := bool(p.get("case_sensitive", false))
	var max_results := int(p.get("max_results", 200))
	var needle := query if case_sensitive else query.to_lower()

	var counts := {}
	var files := _walk("res://", counts)
	var hits: Array = []
	for entry in files:
		var path_value := str(entry)
		if path_value.ends_with(".import") or path_value.ends_with(".uid"):
			continue
		var cls := _classify(path_value.get_file())
		if kind != "all" and cls != kind:
			continue
		if not ["scripts", "scenes", "resources"].has(cls):
			continue
		var f := FileAccess.open(path_value, FileAccess.READ)
		if f == null:
			continue
		var line_no := 0
		while not f.eof_reached():
			var line := f.get_line()
			line_no += 1
			var haystack := line if case_sensitive else line.to_lower()
			if haystack.contains(needle):
				hits.append({"file": path_value, "line": line_no, "text": line.strip_edges().left(200)})
				if hits.size() >= max_results:
					break
		f.close()
		if hits.size() >= max_results:
			break
	return {"ok": true, "hits": hits}


# ---------------------------------------------------------------------------
# Operations: scenes and nodes
# ---------------------------------------------------------------------------

func _scene_tree(p: Dictionary) -> Dictionary:
	var loaded = _load_scene(str(p.get("scene", "")))
	if loaded is Dictionary:
		return loaded
	var handle: SceneHandle = loaded
	var max_depth := int(p.get("max_depth", 0))
	var tree := _describe(handle.root, handle.root, 0, max_depth)
	var result := {"ok": true, "scene": handle.path, "uid": handle.uid, "tree": tree}
	handle.free_tree()
	return result


func _describe(node: Node, scene_root: Node, depth: int, max_depth: int) -> Dictionary:
	var entry := {"name": node.name, "type": node.get_class()}

	var script: Variant = node.get_script()
	if script != null and script is Resource:
		var rp := (script as Resource).resource_path
		if rp != "":
			entry["script"] = rp

	# A node that came from another scene file is an instance; its children are
	# owned by that file, so we mark it and do not descend.
	if node != scene_root and node.scene_file_path != "":
		entry["instance"] = node.scene_file_path
		return entry

	var groups := node.get_groups()
	var visible_groups: Array = []
	for g in groups:
		var gs := str(g)
		if not gs.begins_with("_"):
			visible_groups.append(gs)
	if not visible_groups.is_empty():
		entry["groups"] = visible_groups

	if node.get_child_count() > 0 and (max_depth <= 0 or depth < max_depth):
		var children: Array = []
		for child in node.get_children():
			children.append(_describe(child, scene_root, depth + 1, max_depth))
		entry["children"] = children
	elif node.get_child_count() > 0:
		entry["truncated_children"] = node.get_child_count()
	return entry


func _scene_create(p: Dictionary) -> Dictionary:
	var path_value := _safe_res(str(p.get("scene", "")))
	if path_value == "" or not path_value.ends_with(".tscn"):
		return _err("Scene path must be a res:// path ending in .tscn")
	if FileAccess.file_exists(path_value) and not bool(p.get("overwrite", false)):
		return _err("Scene already exists: %s" % path_value, "Pass overwrite=true to replace it, or pick another path.")

	var type_name := str(p.get("root_type", "Node2D"))
	var root: Variant = _instantiate_class(type_name)
	if root == null:
		return _err(
			"Unknown or non-instantiable node type: %s" % type_name,
			"Did you mean one of: %s? Use api_reference to browse node types." % ", ".join(_class_suggestions(type_name))
		)

	var node_root: Node = root
	node_root.name = str(p.get("root_name", path_value.get_file().get_basename()))

	var script_path := str(p.get("script", ""))
	if script_path != "":
		var attached := _attach_script(node_root, _safe_res(script_path))
		if not attached.get("ok", false):
			node_root.free()
			return attached

	var written := _write_new_scene(node_root, path_value)
	node_root.free()
	if not written.get("ok", false):
		return written
	return {"ok": true, "scene": path_value, "root": {"name": str(p.get("root_name", path_value.get_file().get_basename())), "type": type_name}, "uid": written.get("uid", "")}


func _node_add(p: Dictionary) -> Dictionary:
	var loaded = _load_scene(str(p.get("scene", "")))
	if loaded is Dictionary:
		return loaded
	var handle: SceneHandle = loaded

	var nodes: Array = p.get("nodes", [])
	if nodes.is_empty():
		handle.free_tree()
		return _err("No nodes supplied.")

	var added: Array = []
	for item in nodes:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var spec: Dictionary = item
		var parent_path := str(spec.get("parent", "."))
		var parent := _find_node(handle.root, parent_path)
		if parent == null:
			handle.free_tree()
			return _err("Parent node not found: %s" % parent_path, "Call scene_tree to see the available node paths.")

		var type_name := str(spec.get("type", ""))
		var created: Variant = _instantiate_class(type_name)
		if created == null:
			handle.free_tree()
			return _err(
				"Unknown or non-instantiable node type: %s" % type_name,
				"Did you mean one of: %s? Use api_reference to browse node types." % ", ".join(_class_suggestions(type_name))
			)

		var node: Node = created
		node.name = str(spec.get("name", type_name))
		parent.add_child(node)
		node.owner = handle.root

		var script_path := str(spec.get("script", ""))
		if script_path != "":
			var attached := _attach_script(node, _safe_res(script_path))
			if not attached.get("ok", false):
				handle.free_tree()
				return attached

		var props: Dictionary = spec.get("properties", {})
		var applied := _apply_properties(node, props)
		if not applied.get("ok", false):
			handle.free_tree()
			return applied

		for group in spec.get("groups", []):
			node.add_to_group(StringName(str(group)), true)

		added.append({"path": str(handle.root.get_path_to(node)), "type": type_name, "name": node.name})

	var saved := _save_scene(handle, bool(p.get("force", false)))
	handle.free_tree()
	if not saved.get("ok", false):
		return saved
	return {"ok": true, "scene": handle.path, "added": added}


func _apply_properties(node: Node, props: Dictionary) -> Dictionary:
	for key in props.keys():
		var name := str(key)
		var value: Variant = _coerce(node, name, props[key])
		if value == null and props[key] != null:
			# Coercion failed; a warning was already recorded.
			continue
		node.set(name, value)
		# Verify: Godot silently ignores writes to unknown properties.
		if not _has_property(node, name):
			_warn("Property '%s' does not exist on %s and was ignored." % [name, node.get_class()])
	return {"ok": true}


func _has_property(node: Object, property: String) -> bool:
	for entry in node.get_property_list():
		if str(entry.get("name", "")) == property:
			return true
	return false


func _attach_script(node: Node, script_path: String) -> Dictionary:
	if script_path == "":
		return _err("Empty script path.")
	if not FileAccess.file_exists(script_path):
		return _err("Script not found: %s" % script_path, "Create it first with script_create.")
	if script_path.ends_with(".cs") and not _is_dotnet_build():
		return _err(
			"Cannot attach a C# script with a non-.NET Godot build.",
			"Install the .NET build of Godot and set GODOT_PATH to it."
		)
	var script: Resource = load(script_path)
	if script == null or not (script is Script):
		return _err("Not a valid script: %s" % script_path, "Run script_validate to see parse errors.")
	node.set_script(script)
	return {"ok": true}


func _node_modify(p: Dictionary) -> Dictionary:
	var loaded = _load_scene(str(p.get("scene", "")))
	if loaded is Dictionary:
		return loaded
	var handle: SceneHandle = loaded

	var ops: Array = p.get("operations", [])
	if ops.is_empty():
		handle.free_tree()
		return _err("No operations supplied.")

	var applied: Array = []
	for item in ops:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var spec: Dictionary = item
		var action := str(spec.get("action", ""))
		var node_path := str(spec.get("node", ""))
		var node := _find_node(handle.root, node_path)
		if node == null:
			handle.free_tree()
			return _err("Node not found: %s" % node_path, "Call scene_tree to see the available node paths.")

		match action:
			"set_properties":
				var res := _apply_properties(node, spec.get("properties", {}))
				if not res.get("ok", false):
					handle.free_tree()
					return res
				applied.append("set %d properties on %s" % [Dictionary(spec.get("properties", {})).size(), node_path])
			"rename":
				var new_name := str(spec.get("name", ""))
				if new_name == "":
					handle.free_tree()
					return _err("rename requires 'name'.")
				node.name = new_name
				applied.append("renamed %s -> %s" % [node_path, new_name])
			"delete":
				if node == handle.root:
					handle.free_tree()
					return _err("Cannot delete the scene root.", "Use scene_create to start a different scene, or delete the file.")
				var parent := node.get_parent()
				parent.remove_child(node)
				node.queue_free()
				applied.append("deleted %s" % node_path)
			"reparent":
				var target_path := str(spec.get("to", "."))
				var target := _find_node(handle.root, target_path)
				if target == null:
					handle.free_tree()
					return _err("Reparent target not found: %s" % target_path)
				if node == handle.root:
					handle.free_tree()
					return _err("Cannot reparent the scene root.")
				if target.is_greater_than(node) and node.is_ancestor_of(target):
					handle.free_tree()
					return _err("Cannot reparent a node into its own descendant.")
				node.get_parent().remove_child(node)
				target.add_child(node)
				_adopt(node, handle.root)
				node.owner = handle.root
				applied.append("reparented %s -> %s" % [node_path, target_path])
			"move":
				var index := int(spec.get("index", 0))
				node.get_parent().move_child(node, index)
				applied.append("moved %s to index %d" % [node_path, index])
			"attach_script":
				var res2 := _attach_script(node, _safe_res(str(spec.get("script", ""))))
				if not res2.get("ok", false):
					handle.free_tree()
					return res2
				applied.append("attached script to %s" % node_path)
			"detach_script":
				node.set_script(null)
				applied.append("detached script from %s" % node_path)
			"add_to_group":
				node.add_to_group(StringName(str(spec.get("group", ""))), true)
				applied.append("added %s to group %s" % [node_path, spec.get("group", "")])
			"remove_from_group":
				node.remove_from_group(StringName(str(spec.get("group", ""))))
				applied.append("removed %s from group %s" % [node_path, spec.get("group", "")])
			_:
				handle.free_tree()
				return _err("Unknown action: %s" % action, "Valid actions: set_properties, rename, delete, reparent, move, attach_script, detach_script, add_to_group, remove_from_group.")

	var saved := _save_scene(handle, bool(p.get("force", false)))
	handle.free_tree()
	if not saved.get("ok", false):
		return saved
	return {"ok": true, "scene": handle.path, "applied": applied}


func _node_inspect(p: Dictionary) -> Dictionary:
	var loaded = _load_scene(str(p.get("scene", "")))
	if loaded is Dictionary:
		return loaded
	var handle: SceneHandle = loaded

	var node_path := str(p.get("node", "."))
	var node := _find_node(handle.root, node_path)
	if node == null:
		handle.free_tree()
		return _err("Node not found: %s" % node_path, "Call scene_tree to see the available node paths.")

	var include_defaults := bool(p.get("include_defaults", false))
	var props: Array = []
	for entry in node.get_property_list():
		var usage := int(entry.get("usage", 0))
		if not (usage & PROPERTY_USAGE_EDITOR):
			continue
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or usage & PROPERTY_USAGE_SUBGROUP:
			continue
		var name := str(entry.get("name", ""))
		if name == "" or name.begins_with("script"):
			continue
		var value: Variant = node.get(name)
		if not include_defaults:
			var default_value: Variant = ClassDB.class_get_property_default_value(node.get_class(), StringName(name))
			# Compare including the null case. Properties with no registered
			# default report null, and skipping the comparison for them listed
			# every unset object reference (material, theme, shortcut_context)
			# as though the user had changed it.
			if _same(default_value, value):
				continue
		props.append({"name": name, "type": type_string(typeof(value)), "value": _stringify(value)})

	# Both directions matter. A node is usually the *receiver* of the connections
	# that concern it ("what calls this method?"), and listing only the signals
	# it emits hides exactly the wiring an agent is looking for.
	var signals: Array = []
	for entry in node.get_signal_list():
		for c in node.get_signal_connection_list(StringName(str(entry.get("name", "")))):
			if not _is_authored(c):
				continue
			var callable_value: Callable = c.get("callable")
			signals.append({
				"direction": "out",
				"signal": str(entry.get("name", "")),
				"peer": str(handle.root.get_path_to(callable_value.get_object())) if callable_value.get_object() != null else "?",
				"method": callable_value.get_method(),
			})

	for other in _all_nodes(handle.root):
		if other == node:
			continue
		for entry in other.get_signal_list():
			for c in other.get_signal_connection_list(StringName(str(entry.get("name", "")))):
				if not _is_authored(c):
					continue
				var callable_value: Callable = c.get("callable")
				if callable_value.get_object() != node:
					continue
				signals.append({
					"direction": "in",
					"signal": str(entry.get("name", "")),
					"peer": str(handle.root.get_path_to(other)),
					"method": callable_value.get_method(),
				})

	var script: Variant = node.get_script()
	var result := {
		"ok": true,
		"scene": handle.path,
		"node": node_path,
		"name": node.name,
		"type": node.get_class(),
		"inherits": _inheritance_chain(node.get_class()),
		"script": (script as Resource).resource_path if script != null and script is Resource else "",
		"groups": node.get_groups().map(func(g): return str(g)).filter(func(g): return not g.begins_with("_")),
		"children": node.get_child_count(),
		"properties": props,
		"connections": signals,
	}
	handle.free_tree()
	return result


func _same(a: Variant, b: Variant) -> bool:
	if typeof(a) != typeof(b):
		return false
	if typeof(a) == TYPE_FLOAT:
		return is_equal_approx(a, b)
	return a == b


func _stringify(value: Variant) -> String:
	match typeof(value):
		TYPE_OBJECT:
			if value == null:
				return "null"
			if value is Resource and (value as Resource).resource_path != "":
				return (value as Resource).resource_path
			return "<%s>" % (value as Object).get_class()
		TYPE_NIL: return "null"
		_: return str(value)


func _inheritance_chain(cls: String) -> Array:
	var chain: Array = []
	var current := cls
	while current != "":
		current = ClassDB.get_parent_class(current)
		if current != "":
			chain.append(current)
	return chain


func _scene_instance(p: Dictionary) -> Dictionary:
	var loaded = _load_scene(str(p.get("scene", "")))
	if loaded is Dictionary:
		return loaded
	var handle: SceneHandle = loaded

	var child_path := _safe_res(str(p.get("instance", "")))
	if child_path == "" or not FileAccess.file_exists(child_path):
		handle.free_tree()
		return _err("Scene to instance not found: %s" % child_path)
	if child_path == handle.path:
		handle.free_tree()
		return _err("A scene cannot instance itself.", "That would create infinite recursion.")

	var packed: Resource = load(child_path)
	if packed == null or not (packed is PackedScene):
		handle.free_tree()
		return _err("Not a valid scene: %s" % child_path)

	var parent_path := str(p.get("parent", "."))
	var parent := _find_node(handle.root, parent_path)
	if parent == null:
		handle.free_tree()
		return _err("Parent node not found: %s" % parent_path)

	var count := maxi(1, int(p.get("count", 1)))
	var created: Array = []
	for i in count:
		var inst: Node = (packed as PackedScene).instantiate()
		if inst == null:
			handle.free_tree()
			return _err("Could not instantiate %s" % child_path)
		var base_name := str(p.get("name", inst.name))
		inst.name = base_name if count == 1 else "%s%d" % [base_name, i + 1]
		parent.add_child(inst)
		inst.owner = handle.root
		# Only the instance root gets an owner; its interior stays owned by its
		# own scene file, which is what makes it an instance rather than a copy.
		var props: Dictionary = p.get("properties", {})
		if not props.is_empty():
			_apply_properties(inst, props)
		created.append(str(handle.root.get_path_to(inst)))

	var saved := _save_scene(handle, bool(p.get("force", false)))
	handle.free_tree()
	if not saved.get("ok", false):
		return saved
	return {"ok": true, "scene": handle.path, "instanced": created, "source": child_path}


func _signal_edit(p: Dictionary) -> Dictionary:
	var loaded = _load_scene(str(p.get("scene", "")))
	if loaded is Dictionary:
		return loaded
	var handle: SceneHandle = loaded

	var action := str(p.get("action", "connect"))
	var from_path := str(p.get("from", "."))
	var to_path := str(p.get("to", "."))
	var signal_name := str(p.get("signal", ""))
	var method := str(p.get("method", ""))

	var from_node := _find_node(handle.root, from_path)
	var to_node := _find_node(handle.root, to_path)
	if from_node == null:
		handle.free_tree()
		return _err("Source node not found: %s" % from_path)
	if to_node == null:
		handle.free_tree()
		return _err("Target node not found: %s" % to_path)
	if signal_name == "" or method == "":
		handle.free_tree()
		return _err("Both 'signal' and 'method' are required.")

	if not from_node.has_signal(StringName(signal_name)):
		var available: Array = []
		for entry in from_node.get_signal_list():
			available.append(str(entry.get("name", "")))
		available.sort()
		# Read everything off the node *before* freeing the tree; touching it
		# afterwards raises "previously freed instance" and loses the message.
		var from_class := from_node.get_class()
		handle.free_tree()
		return _err(
			"%s has no signal '%s'." % [from_class, signal_name],
			"Available signals: %s" % ", ".join(available.slice(0, 25))
		)

	var callable_value := Callable(to_node, StringName(method))
	if action == "connect":
		if from_node.is_connected(StringName(signal_name), callable_value):
			handle.free_tree()
			return _err("Already connected.", "Nothing to do.")
		var flags := CONNECT_PERSIST
		if bool(p.get("deferred", false)):
			flags |= CONNECT_DEFERRED
		if bool(p.get("one_shot", false)):
			flags |= CONNECT_ONE_SHOT
		# CONNECT_PERSIST is what makes the connection survive into the .tscn.
		var err := from_node.connect(StringName(signal_name), callable_value, flags)
		if err != OK:
			handle.free_tree()
			return _err("Failed to connect: error %d" % err)
	elif action == "disconnect":
		if not from_node.is_connected(StringName(signal_name), callable_value):
			handle.free_tree()
			return _err("Not connected: %s.%s -> %s.%s" % [from_path, signal_name, to_path, method])
		from_node.disconnect(StringName(signal_name), callable_value)
	else:
		handle.free_tree()
		return _err("Unknown action: %s" % action, "Use 'connect' or 'disconnect'.")

	var saved := _save_scene(handle, bool(p.get("force", false)))
	handle.free_tree()
	if not saved.get("ok", false):
		return saved
	# "root" rather than the literal "." so the rendered form does not read as "..".
	var from_label := "root" if from_path == "." else from_path
	var to_label := "root" if to_path == "." else to_path
	return {"ok": true, "scene": handle.path, "action": action, "detail": "%s.%s -> %s.%s()" % [from_label, signal_name, to_label, method]}


# ---------------------------------------------------------------------------
# Operations: scripts
# ---------------------------------------------------------------------------

func _script_create(p: Dictionary) -> Dictionary:
	var path_value := _safe_res(str(p.get("path", "")))
	if path_value == "" or not (path_value.ends_with(".gd") or path_value.ends_with(".cs")):
		return _err("Script path must end in .gd (or .cs for C# projects).")
	if FileAccess.file_exists(path_value) and not bool(p.get("overwrite", false)):
		return _err("Script already exists: %s" % path_value, "Pass overwrite=true to replace it.")

	var content := str(p.get("content", ""))
	if content == "":
		content = _script_template(str(p.get("extends", "Node")), str(p.get("class_name", "")))

	var dir := path_value.get_base_dir()
	var abs_dir := ProjectSettings.globalize_path(dir)
	if not DirAccess.dir_exists_absolute(abs_dir):
		DirAccess.make_dir_recursive_absolute(abs_dir)

	var f := FileAccess.open(path_value, FileAccess.WRITE)
	if f == null:
		return _err("Cannot write to %s" % path_value, "Check the directory exists and is writable.")
	f.store_string(content)
	f.close()

	var attach_scene := str(p.get("attach_to_scene", ""))
	if attach_scene != "":
		var loaded = _load_scene(attach_scene)
		if loaded is Dictionary:
			return loaded
		var handle: SceneHandle = loaded
		var node := _find_node(handle.root, str(p.get("attach_to_node", ".")))
		if node == null:
			handle.free_tree()
			return _err("Node to attach to not found: %s" % p.get("attach_to_node", "."))
		var attached := _attach_script(node, path_value)
		if not attached.get("ok", false):
			handle.free_tree()
			return attached
		var saved := _save_scene(handle, true)
		handle.free_tree()
		if not saved.get("ok", false):
			return saved
		return {"ok": true, "path": path_value, "attached_to": "%s :: %s" % [attach_scene, p.get("attach_to_node", ".")]}

	return {"ok": true, "path": path_value}


## Parse-checks scripts by loading them. A GDScript that fails to compile
## returns null from load() and prints SCRIPT ERROR lines carrying the file and
## line number, which the server pairs back up with the names reported here.
func _validate_scripts(p: Dictionary) -> Dictionary:
	var targets: Array = []
	var single := str(p.get("path", ""))
	if single != "":
		var one := _safe_res(single)
		if one == "" or not FileAccess.file_exists(one):
			return _err("Script not found: %s" % single)
		targets.append(one)
	else:
		var counts := {}
		for entry in _walk("res://", counts):
			var path_value := str(entry)
			if path_value.get_extension().to_lower() == "gd":
				targets.append(path_value)

	var failed: Array = []
	var checked := 0
	for path_value in targets:
		checked += 1
		# CACHE_MODE_IGNORE forces a real recompile rather than reusing a cached
		# compile from earlier in this same run.
		var script: Resource = ResourceLoader.load(str(path_value), "Script", ResourceLoader.CACHE_MODE_IGNORE)
		if script == null:
			failed.append(str(path_value))
			continue
		# A parse failure still yields a GDScript object, so a null check alone
		# reports every broken file as fine. reload() returns the actual parse
		# status and is the only reliable signal here.
		if script is GDScript and (script as GDScript).reload(true) != OK:
			failed.append(str(path_value))

	return {"ok": true, "checked": checked, "failed": failed}


func _script_template(base: String, cls: String) -> String:
	var header := ""
	if cls != "":
		header = "class_name %s\n" % cls
	var body := "extends %s\n\n\n" % base
	# Match the engine's own new-script template so generated files look native.
	body += "func _ready() -> void:\n\tpass\n"
	return header + body


# ---------------------------------------------------------------------------
# Operations: engine API reference
#
# The highest-leverage read operation here. Models hallucinate Godot APIs
# constantly (wrong signal names, methods that moved between 3.x and 4.x);
# querying ClassDB turns that guesswork into a lookup.
# ---------------------------------------------------------------------------

func _api_reference(p: Dictionary) -> Dictionary:
	var query := str(p.get("query", "")).strip_edges()
	var kind := str(p.get("kind", "all"))
	var inherited := bool(p.get("inherited", false))

	if query == "":
		return _err("Provide a class name (e.g. \"CharacterBody2D\") or a search term.")

	if ClassDB.class_exists(query):
		return _describe_class(query, kind, inherited)

	# Not an exact class: fall back to a substring search over the class list.
	var matches: Array = []
	var lowered := query.to_lower()
	for entry in ClassDB.get_class_list():
		var c := str(entry)
		if c.to_lower().contains(lowered):
			matches.append(c)
	matches.sort()
	if matches.is_empty():
		return _err("No engine class matches '%s'." % query, "Try a shorter term, e.g. 'Body2D' or 'Timer'.")
	if matches.size() == 1:
		return _describe_class(str(matches[0]), kind, inherited)
	return {"ok": true, "search": query, "matches": matches.slice(0, 60), "match_count": matches.size()}


func _describe_class(cls: String, kind: String, inherited: bool) -> Dictionary:
	var no_inherit := not inherited
	var out := {
		"ok": true,
		"class": cls,
		"inherits": _inheritance_chain(cls),
		"instantiable": ClassDB.can_instantiate(cls),
		"is_node": ClassDB.is_parent_class(cls, "Node"),
	}

	if kind == "all" or kind == "methods":
		var methods: Array = []
		for m in ClassDB.class_get_method_list(cls, no_inherit):
			var name := str(m.get("name", ""))
			if name.begins_with("_"):
				continue
			methods.append(_format_method(m))
		methods.sort()
		out["methods"] = methods

	if kind == "all" or kind == "properties":
		var props: Array = []
		for entry in ClassDB.class_get_property_list(cls, no_inherit):
			var usage := int(entry.get("usage", 0))
			if not (usage & PROPERTY_USAGE_EDITOR):
				continue
			if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
				continue
			var name := str(entry.get("name", ""))
			if name == "":
				continue
			var default_value: Variant = ClassDB.class_get_property_default_value(cls, StringName(name))
			props.append({
				"name": name,
				"type": _type_label(entry),
				"default": _stringify(default_value),
			})
		out["properties"] = props

	if kind == "all" or kind == "signals":
		var signals: Array = []
		for s in ClassDB.class_get_signal_list(cls, no_inherit):
			signals.append(_format_signal(s))
		signals.sort()
		out["signals"] = signals

	if kind == "all" or kind == "constants":
		var enums: Dictionary = {}
		for e in ClassDB.class_get_enum_list(cls, no_inherit):
			var enum_name := str(e)
			var values: Array = []
			for c in ClassDB.class_get_enum_constants(cls, StringName(enum_name), true):
				values.append("%s=%d" % [str(c), ClassDB.class_get_integer_constant(cls, StringName(str(c)))])
			enums[enum_name] = values
		out["enums"] = enums

	return out


func _format_method(m: Dictionary) -> String:
	var args: Array = []
	for a in m.get("args", []):
		args.append("%s: %s" % [str(a.get("name", "arg")), _type_label(a)])
	var ret: Dictionary = m.get("return", {})
	var ret_label := _type_label(ret)
	return "%s(%s)%s" % [str(m.get("name", "")), ", ".join(args), "" if ret_label == "void" else " -> " + ret_label]


func _format_signal(s: Dictionary) -> String:
	var args: Array = []
	for a in s.get("args", []):
		args.append("%s: %s" % [str(a.get("name", "arg")), _type_label(a)])
	return "%s(%s)" % [str(s.get("name", "")), ", ".join(args)]


## Prefers the declared class/enum name over the raw Variant type, so callers
## see `Node2D` or `MouseFilter` rather than `Object` or `int`.
func _type_label(info: Dictionary) -> String:
	var hint := int(info.get("hint", 0))
	var hint_string := str(info.get("hint_string", ""))
	var cls := str(info.get("class_name", ""))
	if cls != "":
		return cls
	if hint == PROPERTY_HINT_ENUM and hint_string != "":
		return "enum(%s)" % hint_string.split(",")[0]
	if hint == PROPERTY_HINT_RESOURCE_TYPE and hint_string != "":
		return hint_string
	var t := int(info.get("type", TYPE_NIL))
	if t == TYPE_NIL:
		return "void"
	return type_string(t)


# ---------------------------------------------------------------------------
# Operations: resources
# ---------------------------------------------------------------------------

func _resource_create(p: Dictionary) -> Dictionary:
	var path_value := _safe_res(str(p.get("path", "")))
	if path_value == "" or not (path_value.ends_with(".tres") or path_value.ends_with(".res")):
		return _err("Resource path must end in .tres (text) or .res (binary).", "Prefer .tres so the file stays diffable in git.")
	if FileAccess.file_exists(path_value) and not bool(p.get("overwrite", false)):
		return _err("Resource already exists: %s" % path_value, "Pass overwrite=true to replace it.")

	var type_name := str(p.get("type", ""))
	if not type_name.is_valid_identifier() or not ClassDB.class_exists(type_name):
		return _err("Unknown resource type: %s" % type_name, "Use api_reference to find the right class, e.g. StandardMaterial3D, Theme, Curve.")
	if not ClassDB.is_parent_class(type_name, "Resource"):
		return _err("%s is not a Resource type." % type_name)
	if not ClassDB.can_instantiate(type_name):
		return _err("%s cannot be instantiated directly." % type_name)

	var res: Variant = ClassDB.instantiate(type_name)
	if res == null or not (res is Resource):
		return _err("Could not create %s" % type_name)

	var resource: Resource = res
	var props: Dictionary = p.get("properties", {})
	for key in props.keys():
		var name := str(key)
		resource.set(name, _coerce(resource, name, props[key]))

	var dir := path_value.get_base_dir()
	var abs_dir := ProjectSettings.globalize_path(dir)
	if not DirAccess.dir_exists_absolute(abs_dir):
		DirAccess.make_dir_recursive_absolute(abs_dir)

	var err := ResourceSaver.save(resource, path_value)
	if err != OK:
		return _err("Failed to save resource: error %d" % err)
	return {"ok": true, "path": path_value, "type": type_name}


func _resource_read(p: Dictionary) -> Dictionary:
	var path_value := _safe_res(str(p.get("path", "")))
	if path_value == "" or not FileAccess.file_exists(path_value):
		return _err("Resource not found: %s" % path_value)
	var res: Resource = ResourceLoader.load(path_value, "", ResourceLoader.CACHE_MODE_IGNORE)
	if res == null:
		return _err("Could not load resource: %s" % path_value, "The file may be corrupt or depend on a script that fails to parse.")

	var props: Array = []
	for entry in res.get_property_list():
		var usage := int(entry.get("usage", 0))
		if not (usage & PROPERTY_USAGE_EDITOR):
			continue
		if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
			continue
		var name := str(entry.get("name", ""))
		if name == "" or name == "script":
			continue
		props.append({"name": name, "type": _type_label(entry), "value": _stringify(res.get(name))})
	return {"ok": true, "path": path_value, "type": res.get_class(), "properties": props}


func _resource_edit(p: Dictionary) -> Dictionary:
	var path_value := _safe_res(str(p.get("path", "")))
	if path_value == "" or not FileAccess.file_exists(path_value):
		return _err("Resource not found: %s" % path_value)
	var res: Resource = ResourceLoader.load(path_value, "", ResourceLoader.CACHE_MODE_IGNORE)
	if res == null:
		return _err("Could not load resource: %s" % path_value)

	var props: Dictionary = p.get("properties", {})
	if props.is_empty():
		return _err("No properties supplied.")
	var changed: Array = []
	for key in props.keys():
		var name := str(key)
		if not _has_property(res, name):
			return _err(
				"%s has no property '%s'." % [res.get_class(), name],
				"Call resource_manage with action='read' to list the available properties."
			)
		res.set(name, _coerce(res, name, props[key]))
		changed.append(name)

	var err := ResourceSaver.save(res, path_value)
	if err != OK:
		return _err("Failed to save resource: error %d" % err)
	return {"ok": true, "path": path_value, "changed": changed}


func _import_status(p: Dictionary) -> Dictionary:
	var counts := {}
	var files := _walk("res://", counts)
	var missing: Array = []
	var importable := ["png", "jpg", "jpeg", "svg", "webp", "bmp", "tga", "ogg", "wav", "mp3", "glb", "gltf", "obj", "fbx", "ttf", "otf"]
	for entry in files:
		var path_value := str(entry)
		var ext := path_value.get_extension().to_lower()
		if not importable.has(ext):
			continue
		if not FileAccess.file_exists(path_value + ".import"):
			missing.append(path_value)
		elif not ResourceLoader.exists(path_value):
			missing.append(path_value)
	return {"ok": true, "unimported": missing, "checked": files.size()}


func _export_presets(_p: Dictionary) -> Dictionary:
	var path_value := "res://export_presets.cfg"
	if not FileAccess.file_exists(path_value):
		return {"ok": true, "presets": [], "note": "No export_presets.cfg — add an export preset in the Godot editor first (Project > Export)."}
	var f := FileAccess.open(path_value, FileAccess.READ)
	if f == null:
		return _err("Cannot read export_presets.cfg")
	var text := f.get_as_text()
	f.close()

	var presets: Array = []
	var re := RegEx.new()
	re.compile("name=\"([^\"]*)\"[\\s\\S]*?platform=\"([^\"]*)\"[\\s\\S]*?export_path=\"([^\"]*)\"")
	for m in re.search_all(text):
		presets.append({"name": m.get_string(1), "platform": m.get_string(2), "export_path": m.get_string(3)})
	return {"ok": true, "presets": presets}


func _uid_get(p: Dictionary) -> Dictionary:
	var path_value := _safe_res(str(p.get("path", "")))
	if path_value == "" or not FileAccess.file_exists(path_value):
		return _err("File not found: %s" % path_value)
	var id := ResourceLoader.get_resource_uid(path_value)
	if id == ResourceUID.INVALID_ID:
		return {"ok": true, "path": path_value, "uid": ""}
	return {"ok": true, "path": path_value, "uid": ResourceUID.id_to_text(id)}
