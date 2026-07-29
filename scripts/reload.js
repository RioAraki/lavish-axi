// Rebuild and hand every live session over to the new code in one step.
//
// The published `bin` entry is `dist/cli.mjs`, and a running server keeps that bundle loaded in
// memory, so editing `src/` alone changes nothing: the build has to run, and the old server has
// to go. Idle self-shutdown is not a substitute - a single connected browser chrome (SSE) or
// agent poll cancels the idle timer, so a server with sessions open in tabs can outlive any
// number of rebuilds.
//
// Stopping and respawning are done back to back on purpose. `stop` tells open chromes to reload,
// and a chrome that reloads while no server holds the port lands on an error page; respawning
// immediately keeps that window closed. Respawn uses `--no-open` so the port is bound without
// throwing another browser window at the user.
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateFile } from "../src/paths.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

function run(label, args, { allowFailure = false } = {}) {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return result.status === 0;
}

// Any session the server still considers live works as a respawn target; opening one is what
// spawns the detached server and makes it adopt every other session from state.json.
async function firstLiveSession() {
  try {
    const state = JSON.parse(await readFile(stateFile(), "utf8"));
    return Object.values(state.sessions || {}).find((session) => session && session.status !== "ended") || null;
  } catch {
    return null;
  }
}

run("build", [fileURLToPath(new URL("./build.js", import.meta.url))]);

// A server that is already down makes `stop` a no-op failure, which must not abort the reload.
run("lavish-axi stop", [cli, "stop"], { allowFailure: true });

const session = await firstLiveSession();
if (!session) {
  process.stdout.write("\nNo live session to respawn from - the next `lavish-axi <file>` starts the new build.\n");
} else {
  run(`lavish-axi ${session.file} --no-open`, [cli, session.file, "--no-open"]);
  process.stdout.write(`\nServer respawned on the new build, adopting sessions from ${stateFile()}\n`);
}
