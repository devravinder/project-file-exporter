"use strict";

const { spawnSync } = require("child_process");

// Run git with an argument array (no shell, so no quoting problems) and keep
// stdout as raw bytes (nothing is trimmed - patches must stay byte-exact).
function git(args, { cwd, input, env } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(env || {}) },
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) {
    if (r.error.code === "ENOENT") throw new Error("git was not found on PATH.");
    throw r.error;
  }
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout,
    stderr: (r.stderr || Buffer.alloc(0)).toString("utf8").trim(),
  };
}

// Raw stdout bytes; throws if git fails.
function gitRaw(args, opts) {
  const r = git(args, opts);
  if (!r.ok) throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// Trimmed text stdout; throws if git fails.
function gitOut(args, opts) {
  return gitRaw(args, opts).toString("utf8").trim();
}

module.exports = { git, gitRaw, gitOut };
