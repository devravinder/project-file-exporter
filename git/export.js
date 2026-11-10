"use strict";

const path = require("path");
const { option } = require("../lib/args");
const { gitRaw } = require("../lib/proc");
const { parseSize, formatSize } = require("../lib/size");
const { resolvePath, toLinuxPath } = require("../lib/paths");
const { packEntries, writeParts } = require("../lib/packer");
const { prepareOutDir } = require("../lib/assemble");
const { parseRepoDir, readCommit, subject, shortHash } = require("./repo");
const { chooseCommits } = require("./select");

// Patch of one (non-merge) commit as raw bytes. Prefixes are forced so user
// config (diff.noprefix etc.) cannot change the format `git apply` expects.
function commitPatch(cwd, hash) {
  return gitRaw(
    [
      "diff-tree", "-p", "--binary", "--full-index", "-M", "-r", "--root", "--no-commit-id",
      "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", hash,
    ],
    { cwd }
  );
}

async function run(flags) {
  const repoDir = await option(flags, "repo", "📂 Source git repo path", { parse: parseRepoDir });
  const hashes = await chooseCommits(flags, repoDir);
  if (hashes.length === 0) throw new Error("No commits selected.");
  const limit = await option(flags, "limit", "📏 Max size per part file (KB)", { def: "350", parse: parseSize });
  const outDir = await option(flags, "out", "💾 Output folder", {
    def: "transfer-out",
    parse: resolvePath,
  });

  await prepareOutDir(outDir, flags);

  console.log(`\n  Reading ${hashes.length} commit(s)...\n`);
  const items = [];
  const skippedMerges = [];
  for (const hash of hashes) {
    const c = readCommit(repoDir, hash);
    if (c.parents.length > 1) {
      skippedMerges.push(hash);
      console.log(`  ⊘ merge commit skipped: ${shortHash(hash)} ${subject(c.message)}`);
      continue;
    }
    const patch = commitPatch(repoDir, hash);
    items.push({
      meta: {
        type: "commit",
        hash,
        tree: c.tree,
        parents: c.parents,
        author: c.author,
        committer: c.committer,
        message: c.message,
      },
      data: patch,
    });
    console.log(`  ✔ ${shortHash(hash)}  ${formatSize(patch.length).padStart(9)}  ${subject(c.message)}`);
  }
  if (items.length === 0) throw new Error("Only merge commits were selected - nothing to export.");

  const last = items[items.length - 1].meta;
  items.unshift({
    meta: {
      type: "manifest",
      kind: "git",
      created: new Date().toISOString(),
      source: path.basename(repoDir),
      commitCount: items.length,
      lastCommit: last.hash,
      lastTree: last.tree,
      skippedMerges,
    },
    data: Buffer.alloc(0),
  });

  console.log("\n  Packing...");
  const packed = packEntries(items, limit);
  const written = writeParts(outDir, "git", packed, limit);

  console.log(`\n  ✅ ${items.length - 1} commit(s) → ${written.length} part file(s) in ${toLinuxPath(outDir)}\n`);
  for (const w of written) {
    const pct = Math.round((w.size / limit) * 100);
    console.log(`     ${path.basename(w.file)}  ${formatSize(w.size).padStart(9)}  (${pct}% of limit)`);
  }
  for (const [eid, n] of packed.sliced) {
    const m = items[eid].meta;
    console.log(`\n  ✂ Commit ${shortHash(m.hash)} is large and was split across ${n} part(s) (restored automatically).`);
  }
  if (skippedMerges.length) {
    console.log(`\n  ⚠ ${skippedMerges.length} merge commit(s) skipped (history is exported as a linear sequence).`);
  }
  console.log("\n  Copy the whole folder (or every part file) to the destination, then run: git → Restore.");
}

module.exports = { run };
