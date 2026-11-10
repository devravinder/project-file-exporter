"use strict";

const fs = require("fs");
const path = require("path");
const prompt = require("../lib/prompt");
const { option, confirm } = require("../lib/args");
const { git, gitOut } = require("../lib/proc");
const { formatSize } = require("../lib/size");
const { resolvePath, isDirectory, isEmptyDir, samePath, toLinuxPath, DEFAULT_DIR } = require("../lib/paths");
const { loadParts } = require("../lib/assemble");
const { shortHash, subject, currentHead, isClean } = require("./repo");

// Config used for every apply / commit so line endings are never rewritten.
const RAW = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

// Create / validate the destination. Returns its absolute path.
async function prepareDestination(flags, dir) {
  if (!fs.existsSync(dir)) {
    if (!(await confirm(flags, `${toLinuxPath(dir)} does not exist. Create it and run git init?`, true))) {
      throw new Error("Cancelled.");
    }
    fs.mkdirSync(dir, { recursive: true });
    gitOut(["init", "-q"], { cwd: dir });
    return;
  }
  if (!isDirectory(dir)) throw new Error(`Not a folder: ${dir}`);

  const top = git(["rev-parse", "--show-toplevel"], { cwd: dir });
  if (top.ok) {
    if (!samePath(top.stdout.toString().trim(), dir)) {
      throw new Error(`${dir} is inside another repository (${top.stdout.toString().trim()}). Point to its root or an empty folder.`);
    }
    return;
  }
  if (!isEmptyDir(dir)) throw new Error(`${dir} is not empty and is not a git repository.`);
  if (!(await confirm(flags, `${toLinuxPath(dir)} is an empty folder. Run git init here?`, true))) {
    throw new Error("Cancelled.");
  }
  gitOut(["init", "-q"], { cwd: dir });
}

// Undo a half-applied patch so the repo is clean again.
function cleanup(cwd, hasHead) {
  if (hasHead) {
    git(["reset", "--hard", "-q", "HEAD"], { cwd });
  } else {
    git(["rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "."], { cwd });
    git(["clean", "-fdq"], { cwd });
  }
}

function identEnv(prefix, ident) {
  return {
    [`GIT_${prefix}_NAME`]: ident.name || "unknown",
    [`GIT_${prefix}_EMAIL`]: ident.email || "unknown@localhost",
    [`GIT_${prefix}_DATE`]: ident.when,
  };
}

// Apply one commit; returns null on success, else an error message.
function applyCommit(cwd, c, hadHead) {
  if (c.data.length > 0) {
    const r = git([...RAW, "apply", "--index", "--3way", "--whitespace=nowarn", "-"], { cwd, input: c.data });
    if (!r.ok) {
      cleanup(cwd, hadHead);
      return r.stderr || "git apply failed";
    }
  }
  const r = git(
    [...RAW, "commit", "-q", "--allow-empty", "--allow-empty-message", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-F", "-"],
    {
      cwd,
      input: Buffer.from(c.meta.message, "utf8"),
      env: { ...identEnv("AUTHOR", c.meta.author), ...identEnv("COMMITTER", c.meta.committer) },
    }
  );
  if (!r.ok) {
    cleanup(cwd, hadHead);
    return r.stderr || "git commit failed";
  }
  return null;
}

async function run(flags) {
  const partsDir = await option(flags, "parts", "📥 Folder with the part files", {
    def: DEFAULT_DIR,
    parse: (v) => {
      const d = resolvePath(v);
      if (!isDirectory(d)) throw new Error(`Not a folder: ${d}`);
      return d;
    },
  });

  const pkg = await loadParts(partsDir, { kind: "git", flags });
  const manifest = pkg.entries.find((e) => e.meta.type === "manifest").meta;
  const commits = pkg.entries.filter((e) => e.meta.type === "commit");
  const totalSize = commits.reduce((n, c) => n + c.data.length, 0);

  console.log(`\n  ✔ Export ${pkg.exportId}: ${pkg.total} part(s) verified`);
  console.log(`     ${commits.length} commit(s), ${formatSize(totalSize)} of patches, from "${manifest.source}"`);

  const dest = await option(flags, "dest", "🎯 Destination repo path (created if missing)", { parse: resolvePath });
  await prepareDestination(flags, dest);

  const gitDir = path.resolve(dest, gitOut(["rev-parse", "--git-dir"], { cwd: dest }));
  const stateFile = path.join(gitDir, "gt-restore-state.json");
  let state = readState(stateFile);
  let hadHead = currentHead(dest) !== null;
  const wasFresh = !hadHead;

  if (hadHead && !isClean(dest)) {
    throw new Error("The destination has uncommitted changes. Commit or stash them first.");
  }

  // Resume an interrupted restore of the same export?
  let start = 0;
  let map = {};
  if (state && state.exportId === pkg.exportId && !state.complete) {
    console.log(`\n  ↻ An earlier restore stopped after ${state.nextIndex} of ${commits.length} commit(s).`);
    let action = "resume";
    if (state.failedAt !== null && state.failedAt !== undefined) {
      const c = commits[state.failedAt];
      console.log(`     It failed on ${shortHash(c.meta.hash)} "${subject(c.meta.message)}".`);
      console.log(`     The patch was saved to ${toLinuxPath(path.join(gitDir, "gt-failed.patch"))}.`);
      action = flags.yes
        ? "retry"
        : await prompt.menu("What now?", [
            { label: "Retry that commit", value: "retry" },
            { label: "Skip it (I applied it manually and committed)", value: "skip" },
          ], "q) Quit");
      if (!action) throw new Error("Cancelled.");
    } else if (!(await confirm(flags, "Resume?", true))) {
      throw new Error("Cancelled.");
    }
    start = state.nextIndex;
    map = state.map || {};
    if (action === "skip") {
      map[commits[start].meta.hash] = currentHead(dest);
      start += 1;
    } else if (start > 0 && currentHead(dest) !== state.lastNewHash) {
      throw new Error("HEAD is not where the earlier restore left it - cannot resume safely.");
    }
  } else {
    if (state && state.exportId === pkg.exportId && state.complete) {
      if (!(await confirm(flags, "This export was already restored here. Restore it again (duplicates commits)?", false))) {
        throw new Error("Cancelled.");
      }
    }
    const branch = git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: dest }).stdout.toString().trim();
    console.log(`\n  Target: ${toLinuxPath(dest)}${branch ? ` (branch ${branch})` : ""}${wasFresh ? " - empty repository" : ""}`);
    if (!(await confirm(flags, `Apply ${commits.length} commit(s)?`, true))) throw new Error("Cancelled.");
    if (hadHead) {
      const ref = `refs/gt/backup-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
      gitOut(["update-ref", ref, "HEAD"], { cwd: dest });
      console.log(`  🛟 Backup ref: ${ref}  (undo: git reset --hard ${ref})`);
    }
  }

  hadHead = currentHead(dest) !== null;
  console.log("");
  for (let i = start; i < commits.length; i++) {
    const c = commits[i];
    const err = applyCommit(dest, c, hadHead);
    if (err) {
      fs.writeFileSync(path.join(gitDir, "gt-failed.patch"), c.data);
      writeState(stateFile, {
        exportId: pkg.exportId,
        total: commits.length,
        nextIndex: i,
        failedAt: i,
        lastNewHash: currentHead(dest),
        map,
      });
      console.log(`  ❌ [${i + 1}/${commits.length}] ${shortHash(c.meta.hash)}  ${subject(c.meta.message)}`);
      console.log(`     ${err.split("\n").slice(0, 3).join("\n     ")}`);
      console.log("\n  Stopped. Nothing after this commit was applied; the repository is clean.");
      console.log("  Fix the cause (or apply it manually), then run Restore again to retry / skip.");
      process.exitCode = 1;
      return;
    }
    hadHead = true;
    const newHash = currentHead(dest);
    map[c.meta.hash] = newHash;
    writeState(stateFile, {
      exportId: pkg.exportId,
      total: commits.length,
      nextIndex: i + 1,
      failedAt: null,
      lastNewHash: newHash,
      map,
    });
    console.log(`  ✔ [${i + 1}/${commits.length}] ${shortHash(newHash)}  ${subject(c.meta.message)}`);
  }

  writeState(stateFile, {
    exportId: pkg.exportId,
    total: commits.length,
    nextIndex: commits.length,
    failedAt: null,
    lastNewHash: currentHead(dest),
    complete: true,
    map,
  });
  try {
    fs.unlinkSync(path.join(gitDir, "gt-failed.patch"));
  } catch {
    /* none */
  }

  const tree = gitOut(["rev-parse", "HEAD^{tree}"], { cwd: dest });
  console.log(`\n  ✅ Restored ${commits.length} commit(s) with their original authors, messages and timestamps.`);
  if (tree === manifest.lastTree) {
    console.log("  ✔ Verification: final tree is identical to the source.");
  } else {
    const why = wasFresh && !manifest.skippedMerges.length
      ? "unexpected - check the log"
      : "expected when the destination already had other content or merge commits were skipped";
    console.log(`  ⚠ Verification: final tree differs from the source (${why}).`);
  }
}

module.exports = { run };
