"use strict";

const prompt = require("../lib/prompt");
const { option, confirm, hasFlag } = require("../lib/args");
const { git, gitOut } = require("../lib/proc");
const { parseRepoDir, readCommit, shortHash, subject, isClean } = require("./repo");
const { parseDateTime, formatDate, toGitDate, formatGap, planTimestamps } = require("./timestamps");

function identEnv(prefix, ident, when) {
  return {
    [`GIT_${prefix}_NAME`]: ident.name || "unknown",
    [`GIT_${prefix}_EMAIL`]: ident.email || "unknown@localhost",
    [`GIT_${prefix}_DATE`]: when,
  };
}

function printPlan(commits, times) {
  const row = (i) => {
    const gap = i === 0 ? "" : `+${formatGap((times[i] - times[i - 1]) / 1000)}`;
    return `    ${String(i + 1).padStart(4)}. ${shortHash(commits[i].hash)}  ${formatDate(times[i])}  ${gap.padEnd(10)} ${subject(commits[i].message)}`;
  };
  if (commits.length <= 30) {
    commits.forEach((_, i) => console.log(row(i)));
  } else {
    for (let i = 0; i < 12; i++) console.log(row(i));
    console.log(`       ... ${commits.length - 24} more ...`);
    for (let i = commits.length - 12; i < commits.length; i++) console.log(row(i));
  }
}

async function run(flags) {
  const repoDir = await option(flags, "repo", "📂 Repo path", { parse: parseRepoDir });
  if (!isClean(repoDir)) throw new Error("The repository has uncommitted changes. Commit or stash them first.");

  // Which commits: all on the current branch, or the last N.
  let last = null;
  if (hasFlag(flags, "last")) {
    last = parseInt(flags.last, 10);
    if (!(last > 0)) throw new Error("--last must be a positive number.");
  } else if (!hasFlag(flags, "start")) {
    const all = await prompt.confirm("  Change ALL commits on the current branch?", true);
    if (!all) {
      last = await option({}, "x", "How many of the most recent commits?", {
        parse: (v) => {
          const n = parseInt(v, 10);
          if (!(n > 0)) throw new Error("Enter a positive number.");
          return n;
        },
      });
    }
  }

  const listArgs = ["rev-list", "--topo-order", "--reverse", ...(last ? ["-n", String(last)] : []), "HEAD"];
  const hashes = gitOut(listArgs, { cwd: repoDir }).split("\n").filter(Boolean);
  if (hashes.length === 0) throw new Error("The repository has no commits.");
  const commits = hashes.map((h) => readCommit(repoDir, h));

  // Only a straight line of commits can be re-dated safely.
  for (let i = 0; i < commits.length; i++) {
    const ok = i === 0 ? commits[i].parents.length <= 1 : commits[i].parents.length === 1 && commits[i].parents[0] === commits[i - 1].hash;
    if (!ok) throw new Error(`History is not linear around ${shortHash(commits[i].hash)} (merge commit or side branch). Cannot change timestamps.`);
  }

  console.log(`\n  ${commits.length} commit(s) selected: ${shortHash(commits[0].hash)} → ${shortHash(commits[commits.length - 1].hash)}`);
  const parse = parseDateTime;
  const startMs = await option(flags, "start", "🕒 Start (YYYY-MM-DD hh:mm:ss, time optional)", { parse });
  let endMs = startMs;
  if (commits.length > 1) {
    endMs = await option(flags, "end", "🕓 End   (YYYY-MM-DD hh:mm:ss, time optional)", { parse });
    if (endMs <= startMs) throw new Error("End must be after start.");
  }
  let seed;
  if (hasFlag(flags, "seed")) {
    seed = Number(flags.seed);
    if (!Number.isInteger(seed)) throw new Error("--seed must be an integer.");
  }

  const plan = planTimestamps(commits.length, startMs, endMs, seed);
  console.log(`\n  Planned timestamps (seed ${plan.seed}, gaps 5 min - 1 day):\n`);
  printPlan(commits, plan.times);

  const base = commits[0].parents[0];
  if (base) {
    const b = readCommit(repoDir, base);
    const baseMs = Number(b.committer.when.split(" ")[0]) * 1000;
    if (baseMs >= startMs) {
      console.log(`\n  ⚠ The commit before this range is dated ${formatDate(baseMs)} - not earlier than your start.`);
      if (!(await confirm(flags, "Continue anyway?", false))) throw new Error("Cancelled.");
    }
  }
  const others = gitOut(["for-each-ref", "--contains", commits[0].hash, "--format=%(refname:short)"], { cwd: repoDir })
    .split("\n")
    .filter(Boolean);
  const headRef = git(["symbolic-ref", "-q", "HEAD"], { cwd: repoDir }).stdout.toString().trim();
  const otherRefs = others.filter((r) => `refs/heads/${r}` !== headRef && !r.startsWith("gt/"));

  console.log("\n  ⚠ This rewrites history: every selected commit gets a new hash.");
  console.log("    Do not do this to commits that were already pushed and shared.");
  if (otherRefs.length) console.log(`    Not updated (still point to old commits): ${otherRefs.join(", ")}`);
  if (!(await confirm(flags, "Apply these timestamps?", false))) throw new Error("Cancelled.");

  const oldTip = commits[commits.length - 1].hash;
  const backup = `refs/gt/backup-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  gitOut(["update-ref", backup, oldTip], { cwd: repoDir });

  let parent = base || null;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const when = toGitDate(plan.times[i]);
    const args = ["commit-tree", c.tree, ...(parent ? ["-p", parent] : [])];
    const r = git(args, {
      cwd: repoDir,
      input: Buffer.from(c.message, "utf8"),
      env: { ...identEnv("AUTHOR", c.author, when), ...identEnv("COMMITTER", c.committer, when) },
    });
    if (!r.ok) throw new Error(`commit-tree failed for ${shortHash(c.hash)}: ${r.stderr}. Nothing was changed.`);
    parent = r.stdout.toString().trim();
  }

  const target = headRef || "HEAD";
  gitOut(["update-ref", "-m", "gt retime", target, parent, oldTip], { cwd: repoDir });
  console.log(`\n  ✅ ${commits.length} commit(s) re-dated.`);
  console.log(`  🛟 Backup of the old history: ${backup}  (undo: git reset --hard ${backup})`);
}

module.exports = { run };
