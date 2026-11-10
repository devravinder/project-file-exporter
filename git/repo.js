"use strict";

const { git, gitRaw, gitOut } = require("../lib/proc");
const { resolvePath, isDirectory } = require("../lib/paths");

// Parse a user-typed path that must be inside a git work tree. Returns the absolute path.
function parseRepoDir(input) {
  const dir = resolvePath(input);
  if (!isDirectory(dir)) throw new Error(`Not a folder: ${dir}`);
  const r = git(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  if (!r.ok || r.stdout.toString().trim() !== "true") throw new Error(`Not a git repository: ${dir}`);
  return dir;
}

function shortHash(hash) {
  return hash.slice(0, 7);
}

// Read a commit object exactly as stored (message is byte-exact).
function readCommit(cwd, hash) {
  const raw = gitRaw(["cat-file", "commit", hash], { cwd }).toString("utf8");
  const split = raw.indexOf("\n\n");
  const headerText = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? "" : raw.slice(split + 2);

  const commit = { hash, tree: "", parents: [], author: null, committer: null, message };
  const ident = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/;
  for (const line of headerText.split("\n")) {
    if (line.startsWith(" ")) continue; // continuation (gpgsig etc.)
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "tree") commit.tree = value;
    else if (key === "parent") commit.parents.push(value);
    else if (key === "author" || key === "committer") {
      const m = ident.exec(value);
      if (!m) throw new Error(`Cannot parse ${key} of commit ${hash}: ${value}`);
      commit[key] = { name: m[1], email: m[2], when: `${m[3]} ${m[4]}` };
    }
  }
  return commit;
}

function subject(message) {
  return message.split("\n")[0];
}

function currentHead(cwd) {
  const r = git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd });
  return r.ok ? r.stdout.toString().trim() : null;
}

function isClean(cwd) {
  return gitOut(["status", "--porcelain"], { cwd }) === "";
}

// Commits oldest → newest.
function listCommits(cwd, { mode, count, hashes }) {
  const base = ["rev-list", "--topo-order", "--reverse"];
  if (mode === "all") {
    return lines(gitOut([...base, "HEAD"], { cwd }));
  }
  if (mode === "last") {
    return lines(gitOut([...base, "-n", String(count), "HEAD"], { cwd }));
  }
  if (mode === "unpushed") {
    return lines(gitOut([...base, "--branches", "--not", "--remotes"], { cwd }));
  }
  if (mode === "hashes") {
    const resolved = [];
    for (const h of hashes) {
      const r = git(["rev-parse", "--verify", "--quiet", `${h}^{commit}`], { cwd });
      if (!r.ok) throw new Error(`Unknown commit: ${h}`);
      resolved.push(r.stdout.toString().trim());
    }
    // Order them oldest → newest like the rest of the history.
    const wanted = new Set(resolved);
    const ordered = lines(gitOut([...base, "HEAD"], { cwd })).filter((h) => wanted.has(h));
    const orderedSet = new Set(ordered);
    for (const h of resolved) if (!orderedSet.has(h)) ordered.push(h); // not reachable from HEAD
    return ordered;
  }
  throw new Error(`Unknown selection mode: ${mode}`);
}

function lines(text) {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

module.exports = { parseRepoDir, shortHash, readCommit, subject, currentHead, isClean, listCommits };
