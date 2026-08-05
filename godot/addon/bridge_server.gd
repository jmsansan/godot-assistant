##
## godot-assistant — shared TCP bridge.
##
## Used by both the editor plugin and the runtime autoload. Each side runs its
## own listener and advertises itself through a small discovery file, so there
## is no relaying between them and either can be absent without breaking the
## other.
##
## Protocol: newline-delimited JSON over a loopback TCP socket.
##   client -> {"token": "<token>"}                     (required first frame)
##   client -> {"id": 1, "cmd": "ping", "params": {}}
##   server -> {"id": 1, "ok": true, ...}
##
## Security posture: the listener binds to 127.0.0.1 only and requires a token
## that is generated per session and written to a file inside the project. A
## previous Godot bridge in the wild bound 0.0.0.0 with no auth, which let any
## host on the network drive the editor; neither mistake is repeated here.
##
extends Node

const PROTOCOL_VERSION := 1
const TOKEN_BYTES := 24
## Loopback only. Never change this to "*" or "0.0.0.0".
const BIND_ADDRESS := "127.0.0.1"

signal command_received(command: String, params: Dictionary, responder: Callable)

var _server: TCPServer
var _peers: Array[StreamPeerTCP] = []
var _buffers: Dictionary = {}
var _authed: Dictionary = {}
var _token: String = ""
var _port: int = 0
var _discovery_path: String = ""
var _role: String = "editor"


func start(role: String, preferred_port: int = 0) -> Dictionary:
	_role = role
	_token = _generate_token()
	_server = TCPServer.new()

	# Try the preferred port first so reconnects are cheap, then fall back to an
	# OS-assigned one. Fixed well-known ports collide when several projects are
	# open at once, which is a common complaint about other bridges.
	var port_candidates := [preferred_port, 0] if preferred_port > 0 else [0]
	var listening := false
	for candidate in port_candidates:
		if _server.listen(int(candidate), BIND_ADDRESS) == OK:
			listening = true
			break
	if not listening:
		return {"ok": false, "error": "Could not open a loopback listening socket."}

	_port = _server.get_local_port()
	_discovery_path = "res://.godot/godot-assistant-%s.json" % _role
	_write_discovery()
	set_process(true)
	return {"ok": true, "port": _port, "token": _token}


func stop() -> void:
	for peer in _peers:
		peer.disconnect_from_host()
	_peers.clear()
	_buffers.clear()
	_authed.clear()
	if _server != null:
		_server.stop()
		_server = null
	_remove_discovery()
	set_process(false)


func get_port() -> int:
	return _port


func _write_discovery() -> void:
	# `.godot/` is the engine's own cache directory and is git-ignored by every
	# Godot project template, so this never shows up in the user's diffs.
	var dir := "res://.godot"
	if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(dir)):
		DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(dir))

	var payload := {
		"protocol": PROTOCOL_VERSION,
		"role": _role,
		"port": _port,
		"token": _token,
		"pid": OS.get_process_id(),
		"godot_version": Engine.get_version_info()["string"],
		"started_unix": int(Time.get_unix_time_from_system()),
	}
	var f := FileAccess.open(_discovery_path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(payload))
		f.close()


func _remove_discovery() -> void:
	if _discovery_path == "":
		return
	var abs := ProjectSettings.globalize_path(_discovery_path)
	if FileAccess.file_exists(_discovery_path):
		DirAccess.remove_absolute(abs)


func _generate_token() -> String:
	# Crypto, not randi(): the token is the only thing standing between a local
	# process and control of the editor, and randi() is seeded predictably.
	return Marshalls.raw_to_base64(Crypto.new().generate_random_bytes(TOKEN_BYTES))


func _process(_delta: float) -> void:
	if _server == null:
		return

	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer != null:
			_peers.append(peer)
			_buffers[peer.get_instance_id()] = ""
			_authed[peer.get_instance_id()] = false

	var dropped: Array[StreamPeerTCP] = []
	for peer in _peers:
		peer.poll()
		if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			dropped.append(peer)
			continue
		var available := peer.get_available_bytes()
		if available > 0:
			var chunk := peer.get_utf8_string(available)
			var id := peer.get_instance_id()
			_buffers[id] = str(_buffers.get(id, "")) + chunk
			_drain(peer)

	for peer in dropped:
		_peers.erase(peer)
		_buffers.erase(peer.get_instance_id())
		_authed.erase(peer.get_instance_id())


func _drain(peer: StreamPeerTCP) -> void:
	var id := peer.get_instance_id()
	var buffer := str(_buffers.get(id, ""))
	while true:
		var newline := buffer.find("\n")
		if newline == -1:
			break
		var line := buffer.substr(0, newline)
		buffer = buffer.substr(newline + 1)
		_handle_line(peer, line.strip_edges())
	_buffers[id] = buffer


func _handle_line(peer: StreamPeerTCP, line: String) -> void:
	if line == "":
		return
	var parsed: Variant = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		_send(peer, {"ok": false, "error": "Malformed request."})
		return
	var message: Dictionary = parsed
	var id := peer.get_instance_id()

	if not bool(_authed.get(id, false)):
		# Constant-time-ish comparison is overkill on loopback, but refusing any
		# command before auth is not.
		if str(message.get("token", "")) == _token:
			_authed[id] = true
			_send(peer, {"ok": true, "role": _role, "protocol": PROTOCOL_VERSION})
		else:
			_send(peer, {"ok": false, "error": "Authentication failed."})
			peer.disconnect_from_host()
		return

	var request_id := int(message.get("id", 0))
	var command := str(message.get("cmd", ""))
	var params: Dictionary = message.get("params", {})

	var responder := func(result: Dictionary) -> void:
		var payload := result.duplicate()
		payload["id"] = request_id
		_send(peer, payload)

	command_received.emit(command, params, responder)


func _send(peer: StreamPeerTCP, payload: Dictionary) -> void:
	if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	peer.put_data((JSON.stringify(payload) + "\n").to_utf8_buffer())
