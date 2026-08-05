// Makes the built entry point directly executable so `npx godot-assistant` works.
import { chmodSync, existsSync } from "node:fs";
const entry = new URL("../dist/index.js", import.meta.url);
if (existsSync(entry)) chmodSync(entry, 0o755);
