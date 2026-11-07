// Runs cargo in src-tauri on any OS. npm runs scripts through cmd.exe on
// Windows, where `PATH=... cargo` is not valid, and rustup's bin directory is
// often missing from the PATH an editor or GUI hands down.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
env[pathKey] = [join(homedir(), ".cargo", "bin"), env[pathKey]].filter(Boolean).join(delimiter);

const result = spawnSync("cargo", process.argv.slice(2), {
  cwd: new URL("../src-tauri", import.meta.url),
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
