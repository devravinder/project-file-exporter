const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

// ╔══════════════════════════════════════════════════════════╗
// ║  Git Utility — Interactive CLI (cross-platform)          ║
// ║                                                          ║
// ║  Usage:                                                  ║
// ║    node git-utility.js                                   ║
// ║                                                          ║
// ║  Flow:                                                   ║
// ║    1. Ask for git repo path (+ validation)               ║
// ║    2. Show menu:                                         ║
// ║       1) Print all commits (reverse order)               ║
// ║       2) Print not-pushed commits (reverse order)        ║
// ║       3) Group commits by size                           ║
// ╚══════════════════════════════════════════════════════════╝

// =============================================================
// UTILITIES
// =============================================================

function toLinuxPath(p) {
  return p.replace(/\\/g, "/");
}

// Single shared readline interface for the whole session.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function resolvePath(target) {
  // Accept both windows (\) and linux (/) separators.
  const normalized = target.replace(/[/\\]/g, path.sep);
  return path.resolve(normalized);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Always express size in KB (used for commit grouping output).
function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// Parse a size string. A bare number is treated as KB (e.g. "300" → 300 KB).
// Units are honored when present: "300kb", "1.5mb", "500000b", "2m".
function parseSize(input) {
  if (!input) return NaN;
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = s.match(/^([\d.]+)\s*(b|kb|k|mb|m|gb|g)?$/);
  if (!match) return NaN;
  const value = parseFloat(match[1]);
  if (isNaN(value)) return NaN;
  // Default unit is KB (user works in KB); use "b" only when explicitly given.
  const unit = match[2] || "kb";
  const multipliers = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 * 1024,
    mb: 1024 * 1024,
    g: 1024 * 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };
  return Math.round(value * multipliers[unit]);
}

function runGit(args, cwd) {
  try {
    const result = execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024, // 100MB headroom for large repos
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || "").trim(),
      error: (err.stderr || err.message || "").trim(),
    };
  }
}

function isGitRepo(dir) {
  const result = runGit("rev-parse --is-inside-work-tree", dir);
  return result.success && result.output === "true";
}

// Return commit hashes in reverse order (oldest first → newest last),
// so "first one on top" means the earliest commit prints first.
// NOTE: --reverse makes the oldest commit come first.
function getAllCommits(cwd) {
  const result = runGit('log --pretty=format:"%H" --reverse', cwd);
  if (!result.success) return { success: false, error: result.error, commits: [] };
  const commits = result.output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { success: true, commits };
}

function getUnpushedCommits(cwd) {
  const result = runGit(
    'log --branches --not --remotes --pretty=format:"%H" --reverse',
    cwd
  );
  if (!result.success) return { success: false, error: result.error, commits: [] };
  const commits = result.output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { success: true, commits };
}

function getLastNCommits(n, cwd) {
  // --reverse so the oldest of the N comes first.
  const result = runGit(`log -${n} --pretty=format:"%H" --reverse`, cwd);
  if (!result.success) return { success: false, error: result.error, commits: [] };
  const commits = result.output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { success: true, commits };
}

function getCommitInfo(hash, cwd) {
  const format = "%H|%h|%an|%ai|%s";
  const result = runGit(`show -s --format="${format}" ${hash}`, cwd);
  if (!result.success) return null;
  const parts = result.output.split("|");
  return {
    hash: parts[0],
    shortHash: parts[1],
    author: parts[2],
    date: parts[3],
    subject: parts.slice(4).join("|"),
  };
}

// Compute the change size (in bytes) of a single commit.
// We measure the actual diff payload: the byte length of the patch text
// (text changes) plus the blob size of binary files (which don't appear
// as text in the diff). This is the "size of the change" a commit carries.
function getCommitChangeSize(hash, cwd) {
  let total = 0;

  // Text diff bytes — the patch body only (no commit message/metadata).
  const patch = runGit(`show ${hash} --format="" --no-color`, cwd);
  if (patch.success && patch.output) {
    total += Buffer.byteLength(patch.output, "utf-8");
  }

  // Binary files are shown as "Binary files ... differ" in the diff, so their
  // real byte weight isn't counted above. Add each binary file's blob size.
  const numstat = runGit(`show ${hash} --numstat --format="" --no-color`, cwd);
  if (numstat.success && numstat.output) {
    const lines = numstat.output.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const cols = line.split("\t");
      if (cols.length < 3) continue;
      const added = cols[0];
      const deleted = cols[1];
      if (added === "-" || deleted === "-") {
        // Binary file: numstat reports "-"; use the blob size at this commit.
        const file = cols.slice(2).join("\t");
        const sizeRes = runGit(`cat-file -s ${hash}:"${file}"`, cwd);
        if (sizeRes.success) {
          const b = parseInt(sizeRes.output, 10);
          if (!isNaN(b)) total += b;
        }
      }
    }
  }

  return total;
}

// Greedy bin-packing: walk commits in order, accumulate into the current
// group until adding the next commit would exceed the limit, then start a
// new group. A commit larger than the limit becomes its own group.
function groupBySize(commitSizes, limitBytes) {
  const groups = [];
  let current = [];
  let currentSize = 0;

  for (const { hash, size } of commitSizes) {
    if (size > limitBytes) {
      // Oversized commit: flush current group, give this its own group.
      if (current.length > 0) {
        groups.push(current);
        current = [];
        currentSize = 0;
      }
      groups.push([hash]);
      continue;
    }

    if (currentSize + size > limitBytes && current.length > 0) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(hash);
    currentSize += size;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

// =============================================================
// MENU ACTIONS
// =============================================================

function printCommitList(title, commits, repoFsPath) {
  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(56));
  if (commits.length === 0) {
    console.log("  (no commits)");
    return;
  }
  commits.forEach((hash, idx) => {
    const info = getCommitInfo(hash, repoFsPath);
    if (info) {
      console.log(
        `  ${String(idx + 1).padStart(3)}. ${info.shortHash}  ${info.subject}`
      );
      console.log(`       ${info.author} · ${info.date}`);
    } else {
      console.log(`  ${String(idx + 1).padStart(3)}. ${hash}`);
    }
  });
  console.log(`\n  Total: ${commits.length} commit(s)`);
}

// Minimal: print only the commit ids (full hash), one per line.
function printCommitListMinimal(title, commits) {
  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(56));
  if (commits.length === 0) {
    console.log("  (no commits)");
    return;
  }
  for (const hash of commits) {
    console.log(`  ${hash}`);
  }
  console.log(`\n  Total: ${commits.length} commit(s)`);
}

async function actionAllCommits(repoFsPath) {
  const res = getAllCommits(repoFsPath);
  if (!res.success) {
    console.log(`  ❌ git log failed: ${res.error}`);
    return;
  }
  printCommitList("All commits — detailed (reverse order, oldest first)", res.commits, repoFsPath);
}

async function actionAllCommitsMinimal(repoFsPath) {
  const res = getAllCommits(repoFsPath);
  if (!res.success) {
    console.log(`  ❌ git log failed: ${res.error}`);
    return;
  }
  printCommitListMinimal("All commits — ids only (reverse order, oldest first)", res.commits);
}

async function actionUnpushedCommits(repoFsPath) {
  const res = getUnpushedCommits(repoFsPath);
  if (!res.success) {
    console.log(`  ❌ git log failed: ${res.error}`);
    return;
  }
  printCommitList(
    "Not-pushed commits — detailed (reverse order, oldest first)",
    res.commits,
    repoFsPath
  );
}

async function actionUnpushedCommitsMinimal(repoFsPath) {
  const res = getUnpushedCommits(repoFsPath);
  if (!res.success) {
    console.log(`  ❌ git log failed: ${res.error}`);
    return;
  }
  printCommitListMinimal(
    "Not-pushed commits — ids only (reverse order, oldest first)",
    res.commits
  );
}

async function selectCommitsForGrouping(repoFsPath) {
  console.log("\n  Which commits?");
  console.log("    1) All commits");
  console.log("    2) Only last N commits");
  console.log("    3) Specific commits (comma-separated hashes)");
  console.log("    4) Unpushed commits");

  const choice = await prompt("\n  Select (1-4): ");

  switch (choice) {
    case "1": {
      const res = getAllCommits(repoFsPath);
      if (!res.success) {
        console.log(`  ❌ git log failed: ${res.error}`);
        return null;
      }
      return res.commits;
    }
    case "2": {
      const nInput = await prompt("  How many recent commits (N)? ");
      const n = parseInt(nInput, 10);
      if (!(n > 0)) {
        console.log("  ❌ Invalid number.");
        return null;
      }
      const res = getLastNCommits(n, repoFsPath);
      if (!res.success) {
        console.log(`  ❌ git log failed: ${res.error}`);
        return null;
      }
      return res.commits;
    }
    case "3": {
      const input = await prompt("  Enter commit hashes (comma-separated): ");
      const hashes = input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (hashes.length === 0) {
        console.log("  ❌ No hashes provided.");
        return null;
      }
      // Validate + normalize to full hashes, preserving input order.
      const valid = [];
      for (const h of hashes) {
        const info = getCommitInfo(h, repoFsPath);
        if (info) {
          valid.push(info.hash);
        } else {
          console.log(`  ⚠ Unknown commit, skipping: ${h}`);
        }
      }
      return valid.length > 0 ? valid : null;
    }
    case "4": {
      const res = getUnpushedCommits(repoFsPath);
      if (!res.success) {
        console.log(`  ❌ git log failed: ${res.error}`);
        return null;
      }
      return res.commits;
    }
    default:
      console.log("  ❌ Invalid choice.");
      return null;
  }
}

async function actionGroupBySize(repoFsPath) {
  const commits = await selectCommitsForGrouping(repoFsPath);
  if (!commits || commits.length === 0) {
    console.log("  (nothing to group)");
    return;
  }

  const sizeInput = await prompt("\n  Size limit per group in KB (e.g. 300, 300kb, 1024): ");
  const limitBytes = parseSize(sizeInput);
  if (isNaN(limitBytes) || limitBytes <= 0) {
    console.log("  ❌ Invalid size limit.");
    return;
  }

  console.log(`\n  Measuring commit sizes for ${commits.length} commit(s)...`);

  const commitSizes = [];
  for (const hash of commits) {
    const size = getCommitChangeSize(hash, repoFsPath);
    const info = getCommitInfo(hash, repoFsPath);
    const shortHash = info ? info.shortHash : hash.slice(0, 7);
    commitSizes.push({ hash, shortHash, size });
    const oversized = size > limitBytes ? "  ⚠ exceeds limit (own group)" : "";
    console.log(`    ${shortHash}  ${formatKB(size)}${oversized}`);
  }

  const groups = groupBySize(commitSizes, limitBytes);

  // Build human-friendly groups using short hashes.
  const shortByHash = {};
  for (const c of commitSizes) shortByHash[c.hash] = c.shortHash;

  const result = {
    limit: `${(limitBytes / 1024).toFixed(1)} KB`,
    limitBytes,
    commits: commitSizes.map((c) => c.shortHash),
    groups: groups.map((g) => g.map((h) => shortByHash[h] || h.slice(0, 7))),
  };

  console.log("\n  Result:");
  console.log(JSON.stringify(result, null, 2));

  // Per-group totals for clarity.
  console.log("\n  Group totals:");
  const sizeByHash = {};
  for (const c of commitSizes) sizeByHash[c.hash] = c.size;
  groups.forEach((g, i) => {
    const total = g.reduce((sum, h) => sum + (sizeByHash[h] || 0), 0);
    const shorts = g.map((h) => shortByHash[h] || h.slice(0, 7)).join(", ");
    // A group only exceeds the limit when it holds a single oversized commit
    // (one commit's change is bigger than the limit and cannot be split).
    const marker = total > limitBytes ? "  ⚠ single oversized commit" : "";
    console.log(`    Group ${i + 1}: [${shorts}] → ${formatKB(total)}${marker}`);
  });

  // Optional: save result to a JSON file.
  const save = (await prompt("\n  Save result to a JSON file? (y/n): ")).toLowerCase();
  if (save === "y") {
    const defaultName = "git-groups.json";
    const nameInput = await prompt(`  File name (default ${defaultName}): `);
    const fileName = nameInput || defaultName;
    const outPath = path.resolve(process.cwd(), fileName);
    try {
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
      console.log(`  ✅ Saved to ${toLinuxPath(outPath)}`);
    } catch (e) {
      console.log(`  ❌ Failed to save: ${e.message}`);
    }
  }
}

// =============================================================
// REPO PATH VALIDATION
// =============================================================

async function askRepoPath() {
  while (true) {
    const input = await prompt("  📂 Enter git repo path (or 'q' to quit): ");
    if (!input) {
      console.log("  ⚠ Path is required.\n");
      continue;
    }
    if (input.toLowerCase() === "q" || input.toLowerCase() === "quit") {
      return null;
    }

    const repoFsPath = resolvePath(input);

    if (!fs.existsSync(repoFsPath)) {
      console.log(`  ❌ Path does not exist: ${toLinuxPath(repoFsPath)}\n`);
      continue;
    }

    const stat = fs.statSync(repoFsPath);
    if (!stat.isDirectory()) {
      console.log(`  ❌ Path is not a directory: ${toLinuxPath(repoFsPath)}\n`);
      continue;
    }

    if (!isGitRepo(repoFsPath)) {
      console.log(`  ❌ Not a git repository: ${toLinuxPath(repoFsPath)}\n`);
      continue;
    }

    console.log(`  ✔ Valid git repo: ${toLinuxPath(repoFsPath)}`);
    return repoFsPath;
  }
}

// =============================================================
// MENU LOOP
// =============================================================

async function menuLoop(repoFsPath) {
  while (true) {
    console.log("\n  ===================== Menu =====================");
    console.log("    1) Print all commits        — detailed (msg + time)");
    console.log("    2) Print all commits        — minimal (ids only)");
    console.log("    3) Print not-pushed commits — detailed (msg + time)");
    console.log("    4) Print not-pushed commits — minimal (ids only)");
    console.log("    5) Group commits by size");
    console.log("    q) Quit");
    console.log("  ===============================================");

    const choice = (await prompt("\n  Select an option: ")).toLowerCase();

    switch (choice) {
      case "1":
        await actionAllCommits(repoFsPath);
        break;
      case "2":
        await actionAllCommitsMinimal(repoFsPath);
        break;
      case "3":
        await actionUnpushedCommits(repoFsPath);
        break;
      case "4":
        await actionUnpushedCommitsMinimal(repoFsPath);
        break;
      case "5":
        await actionGroupBySize(repoFsPath);
        break;
      case "q":
      case "quit":
        console.log("\n  👋 Bye.");
        return;
      default:
        console.log("  ❌ Invalid option.");
        break;
    }
  }
}

// =============================================================
// MAIN
// =============================================================

async function main() {
  console.log("\n  =============== Git Utility ===============\n");

  // Ensure git is available.
  const gitCheck = runGit("--version", process.cwd());
  if (!gitCheck.success) {
    console.log("  ❌ Git is not installed or not on PATH.");
    rl.close();
    process.exit(1);
  }

  const repoFsPath = await askRepoPath();
  if (!repoFsPath) {
    console.log("  👋 Bye.");
    rl.close();
    return;
  }

  await menuLoop(repoFsPath);
  rl.close();
}

main().catch((err) => {
  console.error("  ❌ Error:", err.message);
  rl.close();
  process.exit(1);
});
