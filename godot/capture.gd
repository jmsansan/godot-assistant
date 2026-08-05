##
## godot-assistant — offscreen scene renderer.
##
## Renders a scene to a PNG so an agent can actually see what it built. Visual
## bugs vastly outnumber crashes in game work, and without this the only signal
## available is the console.
##
## Must run *without* `--headless`: headless disables the rendering server, and
## awaiting a drawn frame under it never resolves.
##
## Run as:
##   godot --path <project> --script capture.gd --resolution WxH -- '{"scene":...}'
##
extends SceneTree

const BEGIN := "<<<GODOT_ASSISTANT_RESULT"
const END := "GODOT_ASSISTANT_RESULT>>>"

## Frames to render before grabbing the image. One frame is not enough: the
## first is often blank while the renderer warms up, and _ready/@onready work
## lands during the first couple of idle frames.
const DEFAULT_WARMUP_FRAMES := 6

## Wall-clock ceiling. A scene whose _ready blocks would otherwise hang forever.
const MAX_SECONDS := 25.0

var _params: Dictionary = {}
var _started_ms: int = 0
var _done := false


func _initialize() -> void:
	_started_ms = Time.get_ticks_msec()
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		_emit({"ok": false, "error": "No capture payload supplied."})
		return

	var parsed: Variant = JSON.parse_string(args[0])
	if typeof(parsed) != TYPE_DICTIONARY:
		_emit({"ok": false, "error": "Capture payload is not a JSON object."})
		return
	_params = parsed

	var scene_path := str(_params.get("scene", ""))
	if scene_path == "":
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene_path == "":
		_emit({"ok": false, "error": "No scene given and the project has no main scene set."})
		return
	if not FileAccess.file_exists(scene_path):
		_emit({"ok": false, "error": "Scene not found: %s" % scene_path})
		return

	var packed: Resource = load(scene_path)
	if packed == null or not (packed is PackedScene):
		_emit({"ok": false, "error": "Could not load scene: %s" % scene_path})
		return

	var instance: Node = (packed as PackedScene).instantiate()
	if instance == null:
		_emit({"ok": false, "error": "Could not instantiate scene: %s" % scene_path})
		return

	# Subwindows must be embedded or they render into separate OS windows that
	# the root viewport capture would miss.
	root.set_embedding_subwindows(true)

	var bg := str(_params.get("background", ""))
	if bg != "":
		root.transparent_bg = false
		# Set the renderer's clear colour rather than adding a ColorRect. Canvas
		# items always draw on top of 3D regardless of z_index, so a backdrop
		# node would render the whole 3D scene invisible.
		RenderingServer.set_default_clear_color(Color(bg))

	root.add_child(instance)
	_capture_when_ready(scene_path)


func _capture_when_ready(scene_path: String) -> void:
	var frames := int(_params.get("frames", DEFAULT_WARMUP_FRAMES))
	frames = clampi(frames, 1, 600)

	for i in frames:
		if _elapsed() > MAX_SECONDS:
			_emit({"ok": false, "error": "Timed out waiting for the scene to render.",
				"hint": "The scene may block in _ready(), or wait on input. Try a simpler scene."})
			return
		await process_frame

	# One extra draw pass so the final frame is guaranteed flushed to the target.
	await RenderingServer.frame_post_draw

	var texture := root.get_texture()
	if texture == null:
		_emit({"ok": false, "error": "No render target available.",
			"hint": "Capture requires a windowed run; it cannot work under --headless."})
		return

	var image := texture.get_image()
	if image == null:
		_emit({"ok": false, "error": "Failed to read the rendered frame."})
		return

	var out_path := str(_params.get("out", ""))
	if out_path == "":
		_emit({"ok": false, "error": "No output path supplied."})
		return

	var err := image.save_png(out_path)
	if err != OK:
		_emit({"ok": false, "error": "Failed to write PNG to %s (error %d)" % [out_path, err]})
		return

	_emit({
		"ok": true,
		"path": out_path,
		"scene": scene_path,
		"width": image.get_width(),
		"height": image.get_height(),
	})


func _elapsed() -> float:
	return float(Time.get_ticks_msec() - _started_ms) / 1000.0


func _emit(result: Dictionary) -> void:
	if _done:
		return
	_done = true
	print(BEGIN)
	print(JSON.stringify(result))
	print(END)
	quit(0)
