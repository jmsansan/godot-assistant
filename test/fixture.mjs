/**
 * Builds a throwaway Godot project for the QA suite.
 *
 * Deliberately not trivial: it has a script with exported variables, a scene
 * that instances another scene, a sub-resource, a signal connection and a UID,
 * because those are exactly the things a naive scene rewrite destroys.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function createFixture(root) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "scenes"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });

  const write = (rel, content) => writeFileSync(path.join(root, rel), content, "utf8");

  write(
    "project.godot",
    `; Engine configuration file.
config_version=5

[application]

config/name="QA Fixture"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.4", "GL Compatibility")

[autoload]

GameState="*res://scripts/game_state.gd"

[input]

jump={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":32,"physical_keycode":0,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}

[layer_names]

2d_physics/layer_1="world"
2d_physics/layer_2="player"

[rendering]

renderer/rendering_method="gl_compatibility"
`,
  );

  write(
    "scripts/game_state.gd",
    `extends Node

var score: int = 0


func add_point() -> void:
	score += 1
`,
  );

  write(
    "scripts/player.gd",
    `extends CharacterBody2D

@export var speed: float = 260.0
@export var jump_force: float = -420.0

var gravity: float = 980.0


func _physics_process(delta: float) -> void:
	velocity.y += gravity * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = jump_force
	velocity.x = Input.get_axis("ui_left", "ui_right") * speed
	move_and_slide()


func _on_area_entered(_area: Area2D) -> void:
	GameState.add_point()
`,
  );

  write(
    "scenes/coin.tscn",
    `[gd_scene load_steps=2 format=3 uid="uid://bqacoin00001"]

[sub_resource type="CircleShape2D" id="CircleShape2D_coin"]
radius = 8.0

[node name="Coin" type="Area2D"]

[node name="Shape" type="CollisionShape2D" parent="."]
shape = SubResource("CircleShape2D_coin")

[node name="Visual" type="ColorRect" parent="."]
offset_left = -8.0
offset_top = -8.0
offset_right = 8.0
offset_bottom = 8.0
color = Color(1, 0.85, 0.1, 1)
`,
  );

  write(
    "scenes/player.tscn",
    `[gd_scene load_steps=3 format=3 uid="uid://bqaplayer0001"]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_player"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_body"]
size = Vector2(24, 32)

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1_player")
speed = 300.0

[node name="Body" type="CollisionShape2D" parent="."]
shape = SubResource("RectangleShape2D_body")

[node name="Sprite" type="ColorRect" parent="."]
offset_left = -12.0
offset_top = -16.0
offset_right = 12.0
offset_bottom = 16.0
color = Color(0.3, 0.7, 1, 1)

[node name="Hitbox" type="Area2D" parent="."]

[connection signal="area_entered" from="Hitbox" to="." method="_on_area_entered"]
`,
  );

  // A Container-based UI. Containers wire up many engine-internal signal
  // connections at instantiation, so this is the case that proves inspection
  // reports only user-authored wiring.
  write(
    "scripts/hud.gd",
    `extends Control


func _on_start_pressed() -> void:
	GameState.add_point()
`,
  );

  write(
    "scenes/hud.tscn",
    `[gd_scene load_steps=2 format=3 uid="uid://bqahud000001"]

[ext_resource type="Script" path="res://scripts/hud.gd" id="1_hud"]

[node name="Hud" type="Control"]
layout_mode = 3
script = ExtResource("1_hud")

[node name="Rows" type="VBoxContainer" parent="."]
layout_mode = 2
offset_right = 200.0
offset_bottom = 80.0

[node name="Title" type="Label" parent="Rows"]
layout_mode = 2
text = "Score"

[node name="Start" type="Button" parent="Rows"]
layout_mode = 2
text = "Start"

[connection signal="pressed" from="Rows/Start" to="." method="_on_start_pressed"]
`,
  );

  // A 3D scene, so capture can be checked against the case where a 2D backdrop
  // would draw over the whole thing.
  write(
    "scenes/world.tscn",
    `[gd_scene load_steps=2 format=3 uid="uid://bqaworld00001"]

[sub_resource type="BoxMesh" id="BoxMesh_1"]

[node name="World" type="Node3D"]

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.6, 0.8, 0, -0.8, 0.6, 0, 4, 0)

[node name="Cam" type="Camera3D" parent="."]
transform = Transform3D(0.7, -0.3, 0.6, 0, 0.9, 0.45, -0.7, -0.3, 0.6, 4, 3, 4)

[node name="Box" type="MeshInstance3D" parent="."]
mesh = SubResource("BoxMesh_1")
`,
  );

  write(
    "scenes/main.tscn",
    `[gd_scene load_steps=3 format=3 uid="uid://bqamain000001"]

[ext_resource type="PackedScene" uid="uid://bqaplayer0001" path="res://scenes/player.tscn" id="1_player"]
[ext_resource type="PackedScene" uid="uid://bqacoin00001" path="res://scenes/coin.tscn" id="2_coin"]

[node name="Main" type="Node2D"]

[node name="Background" type="ColorRect" parent="."]
offset_right = 640.0
offset_bottom = 360.0
color = Color(0.1, 0.1, 0.15, 1)

[node name="Player" parent="." instance=ExtResource("1_player")]
position = Vector2(120, 200)

[node name="Coin" parent="." instance=ExtResource("2_coin")]
position = Vector2(320, 180)
`,
  );

  return root;
}
