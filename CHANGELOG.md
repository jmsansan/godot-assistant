# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [Versioning](CONTRIBUTING.md#versioning) for what counts as a breaking change.

## [Unreleased]

## [1.0.0] - 2026-08-05

First public release.

### Added

- **25 MCP tools** covering project discovery, scene and node editing, scripting,
  engine API reference, running and debugging, visual capture, resources, editor
  control and export.
- **Zero-setup command-line tier.** Every core capability, including rendering a
  scene to PNG, works with nothing but a Godot binary installed. The engine-side
  script is passed by absolute path, so running an operation never adds files to
  the user's project.
- **`api_reference`**, which queries the installed engine's ClassDB for real method
  signatures, properties, signals and enums. Replaces recalled (and frequently
  wrong) Godot APIs with a lookup against the exact version in use.
- **Optional live bridge addon** (`bridge_install`) for editor and running-game
  control: runtime inspection, input simulation, and game/editor screenshots.
  Loopback-only, token authenticated, inert in non-debug builds. Bridge protocol
  version 1.
- **`doctor`** and **`install`** subcommands for diagnosing setup and printing
  client configuration.
- **Read-only mode** via `--read-only` / `GODOT_ASSISTANT_READ_ONLY=1`.

### Security

- Node types are validated as bare identifiers and checked against ClassDB on both
  the server and engine side, so a script path cannot be passed as a node type and
  executed inside the Godot process.
- Paths are normalised, NUL-checked, and resolved through `realpath` before the
  containment check, so symlinks cannot escape the project root.
- The bridge binds `127.0.0.1` only and requires a per-session token generated
  from `Crypto.generate_random_bytes`.

### Data safety

- Saves that would drop a script reference are refused rather than written.
- Scene `uid://` values are preserved across the repack that editing requires.
- Scenes containing C# scripts are refused by non-.NET Godot builds, which would
  otherwise silently strip those attachments.

### Verified against

Godot 4.7.1 on macOS, with 102 end-to-end checks against a real engine. Windows and
Linux discovery paths are implemented; CI exercises Linux.

[Unreleased]: https://github.com/jmsansan/godot-assistant/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jmsansan/godot-assistant/releases/tag/v1.0.0
