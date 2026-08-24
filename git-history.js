const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

// ╔══════════════════════════════════════════════════════════╗
// ║  Git History Transfer — Command-based CLI               ║
// ║                                                         ║
// ║  Usage:                                                 ║
// ║    node git-history.js <command> <config-file>          ║
// ║    node git-history.js <config-file>   (interactive)    ║
// ║    node git-history.js                 (fully prompted) ║
// ║                                                         ║
// ║  Commands:                                              ║
// ║    init   | i  — Create config file only                ║
// ║    read   | r  — Export commits as patches (from repo)  ║
// ║    write  | w  — Apply patches to repo                  ║
// ║    info       — Show config & commit summary            ║
// ║    help   | h  — Show help                              ║
// ╚══════════════════════════════════════════════════════════╝

// =============================================================
// UTILITIES
// =============================================================

function toLinuxPath(p) {
  return p.replace(/\\/g, "/");
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function resolveConfigPath(input) {
  const normalized = input.replace(/[/\\]/g, path.sep);
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(process.cwd(), normalized);
}

function resolvePath(target) {
  const normalized = target.replace(/\//g, path.sep);
  return path.resolve(normalized);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function runGit(args, cwd) {
  try {
    const result = execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024, // 50MB for large patches
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

function getCommitInfo(hash, cwd) {
  const format = "%H|%h|%an|%ae|%ai|%s";
  const result = runGit(`log -1 --format="${format}" ${hash}`, cwd);
  if (!result.success) return null;

  const parts = result.output.split("|");
  return {
    hash: parts[0],
    shortHash: parts[1],
    author: parts[2],
    email: parts[3],
    date: parts[4],
    subject: parts.slice(5).join("|"), // subject may contain |
  };
}

function getLastNCommits(n, cwd) {
  const result = runGit(`log -${n} --format="%H" --reverse`, cwd);
  if (!result.success) return [];
  return result.output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// =============================================================
// CONFIG FILE HELPERS
// =============================================================

function loadConfig(configFilePath) {
  if (fs.existsSync(configFilePath)) {
    return JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
  }
  return null;
}

function saveConfig(configFilePath, config) {
  const configDir = path.dirname(configFilePath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), "utf-8");
}

// =============================================================
// COMMANDS
// =============================================================

function showHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Git History Transfer — Help                            ║
╚══════════════════════════════════════════════════════════╝

  Usage:
    node git-history.js <command> <config-file>
    node git-history.js <config-file>          (interactive mode)
    node git-history.js                        (fully prompted)

  Commands:
    init   | i    Create a config file (repo path + commit selection)
    read   | r    Export commits from repo as patch files
    write  | w    Apply patch files to repo
    info          Show config & commit summary
    help   | h    Show this help message

  Examples:
    node git-history.js init transfer.json
    node git-history.js read transfer.json
    node git-history.js write transfer.json
    node git-history.js info transfer.json
    node git-history.js transfer.json

  Config file format (JSON):
    {
      "repo": "C:/path/to/repo",
      "commits": ["abc123", "def456"],
      "lastNCommits": 5,
      "options": {
        "threeway": true,
        "keepAuthor": true
      }
    }

  Workflow:
    1. Set "repo" to source → run "read" → patches stored in config
    2. Copy config to another system
    3. Set "repo" to target → run "write" → patches applied

  Notes:
    - "repo" is the source when reading, target when writing
    - Patches are stored inside the config file (single-file portable)
    - Provide either "commits" array OR "lastNCommits" (not both)
    - If both are provided, "commits" takes priority
    - "threeway": true enables 3-way merge on conflicts (recommended)
    - "keepAuthor": true preserves original author info (default)
    - Merge commits are automatically skipped
`);
}

async function cmdInit(configFilePath) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  let config = loadConfig(configFilePath);

  if (config) {
    console.log("  ⚠ Config file already exists.");
    const overwrite = (await prompt("  Overwrite? (y/n): ")).toLowerCase();
    if (overwrite !== "y") {
      console.log("  Cancelled.");
      return;
    }
  }

  config = {
    repo: "",
    commits: [],
    lastNCommits: 0,
    options: {
      threeway: true,
      keepAuthor: true,
    },
  };

  // Repo path
  const repoInput = await prompt("  📂 Enter repo path: ");
  if (!repoInput) {
    console.log("  ❌ Repo path is required. Exiting.");
    process.exit(1);
  }
  config.repo = toLinuxPath(repoInput);

  const repoFsPath = resolvePath(config.repo);
  if (!fs.existsSync(repoFsPath)) {
    console.log(`  ⚠ Warning: Path does not exist yet: ${config.repo}`);
  } else if (!isGitRepo(repoFsPath)) {
    console.log(`  ⚠ Warning: Path is not a git repository: ${config.repo}`);
  }

  // Commit selection
  const mode = (
    await prompt("  🔢 Select commits by: [h]ashes or [n]umber of last N commits? ")
  ).toLowerCase();

  if (mode === "h" || mode === "hashes") {
    const hashInput = await prompt("  #️⃣  Enter commit hashes (comma separated): ");
    if (hashInput) {
      config.commits = hashInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } else {
    const nInput = await prompt("  🔢 How many recent commits? ");
    const n = parseInt(nInput, 10);
    if (n > 0) {
      config.lastNCommits = n;
    } else {
      console.log("  ⚠ Invalid number, defaulting to 5.");
      config.lastNCommits = 5;
    }
  }

  // Options
  const threeway = (await prompt("  🔀 Enable 3-way merge for conflicts? (y/n, default y): ")).toLowerCase();
  config.options.threeway = threeway !== "n";

  saveConfig(configFilePath, config);

  console.log(`\n  ✅ Config file created!`);
  console.log(`     Repo       : ${config.repo}`);
  if (config.commits.length > 0) {
    console.log(`     Commits    : ${config.commits.length} specific hash(es)`);
  } else {
    console.log(`     Last N     : ${config.lastNCommits} commits`);
  }
  console.log(`     3-way merge: ${config.options.threeway ? "yes" : "no"}`);
  console.log(`     Saved at   : ${configFileLinux}`);
}

async function cmdRead(configFilePath, existingConfig) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  const config = existingConfig || loadConfig(configFilePath);

  if (!config) {
    console.log("  ❌ Config file not found. Run 'init' first.");
    return;
  }

  if (!config.repo) {
    console.log("  ❌ 'repo' not set in config. Run 'init' first.");
    return;
  }

  const repoFsPath = resolvePath(config.repo);

  if (!fs.existsSync(repoFsPath)) {
    console.log(`  ❌ Repo does not exist: ${config.repo}`);
    return;
  }

  if (!isGitRepo(repoFsPath)) {
    console.log(`  ❌ Path is not a git repository: ${config.repo}`);
    return;
  }

  // Determine which commits to export
  let commitHashes = [];

  if (config.commits && config.commits.length > 0) {
    commitHashes = config.commits;
    console.log(`  📋 Using ${commitHashes.length} specified commit hash(es)\n`);
  } else if (config.lastNCommits && config.lastNCommits > 0) {
    commitHashes = getLastNCommits(config.lastNCommits, repoFsPath);
    console.log(`  📋 Found ${commitHashes.length} commits (last ${config.lastNCommits} requested)\n`);
  } else {
    console.log("  ❌ No commits specified. Set 'commits' array or 'lastNCommits' in config.");
    return;
  }

  if (commitHashes.length === 0) {
    console.log("  ❌ No commits found in the repository.");
    return;
  }

  // Export each commit as a patch — store in config
  let exported = 0;
  let skipped = 0;
  const patches = [];

  for (let i = 0; i < commitHashes.length; i++) {
    const hash = commitHashes[i];
    const info = getCommitInfo(hash, repoFsPath);

    if (!info) {
      console.log(`  ⚠ Skipping unknown commit: ${hash}`);
      skipped++;
      continue;
    }

    // Check if it's a merge commit
    const parentCheck = runGit(`cat-file -p ${hash}`, repoFsPath);
    const parentLines = parentCheck.output
      .split("\n")
      .filter((l) => l.startsWith("parent "));
    if (parentLines.length > 1) {
      console.log(`  ⊘ Skipping merge commit: ${info.shortHash} — ${info.subject}`);
      skipped++;
      continue;
    }

    // Generate patch using format-patch
    const patchIndex = String(i + 1).padStart(4, "0");
    const result = runGit(
      `format-patch -1 ${hash} --stdout`,
      repoFsPath
    );

    if (!result.success) {
      console.log(`  ❌ Failed to export: ${info.shortHash} — ${result.error}`);
      skipped++;
      continue;
    }

    // Store patch content in array
    patches.push({
      index: i + 1,
      hash: info.hash,
      shortHash: info.shortHash,
      author: info.author,
      email: info.email,
      date: info.date,
      subject: info.subject,
      patch: result.output,
    });

    exported++;
    console.log(`  ✔ [${patchIndex}] ${info.shortHash} — ${info.subject}`);
  }

  // Store patches in config
  config.patches = patches;
  saveConfig(configFilePath, config);

  const configSize = fs.statSync(configFilePath).size;

  console.log(`\n  ✅ Done! ${exported} patches exported, ${skipped} skipped.`);
  console.log(`     All patches stored in config file.`);
  console.log(`     Config size: ${formatSize(configSize)}`);
  console.log(`     Saved at   : ${configFileLinux}`);
}

async function cmdWrite(configFilePath, existingConfig) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  const config = existingConfig || loadConfig(configFilePath);

  if (!config) {
    console.log("  ❌ Config file not found. Run 'init' first.");
    return;
  }

  if (!config.repo) {
    console.log("  ❌ 'repo' not set in config. Run 'init' first.");
    return;
  }

  const repoFsPath = resolvePath(config.repo);

  if (!fs.existsSync(repoFsPath)) {
    console.log(`  ❌ Repo does not exist: ${config.repo}`);
    return;
  }

  if (!isGitRepo(repoFsPath)) {
    console.log(`  ❌ Path is not a git repository: ${config.repo}`);
    return;
  }

  // Check patches exist in config
  if (!config.patches || config.patches.length === 0) {
    console.log(`  ❌ No patches found in config file.`);
    console.log(`     Run 'read' first to export patches.`);
    return;
  }

  console.log(`  🎯 Target repo : ${config.repo}`);
  console.log(`  📋 Patches     : ${config.patches.length}\n`);

  // Show commit list
  for (const p of config.patches) {
    console.log(`     ${p.index}. ${p.shortHash} — ${p.subject}`);
  }
  console.log("");

  // Confirm before applying
  const confirm = (await prompt(`  ⚡ Apply ${config.patches.length} patch(es) to repo? (y/n): `)).toLowerCase();
  if (confirm !== "y") {
    console.log("  Cancelled.");
    return;
  }

  console.log("");

  // Write patches to temp files and apply one by one
  const tempDir = path.join(path.dirname(configFilePath), ".tmp_patches");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let applied = 0;
  let failed = 0;
  const failedPatches = [];
  const threeway = config.options && config.options.threeway ? " --3way" : "";

  for (const patchEntry of config.patches) {
    // Write patch to temp file
    const tempFile = path.join(tempDir, `${String(patchEntry.index).padStart(4, "0")}.patch`);
    fs.writeFileSync(tempFile, patchEntry.patch, "utf-8");

    const tempFileEscaped = tempFile.replace(/\\/g, "/");

    // Try to apply the patch
    const result = runGit(
      `am${threeway} "${tempFileEscaped}"`,
      repoFsPath
    );

    if (result.success) {
      applied++;
      console.log(`  ✔ Applied: [${patchEntry.index}] ${patchEntry.shortHash} — ${patchEntry.subject}`);
    } else {
      // Abort the failed am and record the failure
      runGit("am --abort", repoFsPath);
      failed++;
      failedPatches.push({ entry: patchEntry, error: result.error });
      console.log(`  ❌ Failed:  [${patchEntry.index}] ${patchEntry.shortHash} — ${patchEntry.subject}`);
      if (result.error) {
        const errorLine = result.error.split("\n")[0];
        console.log(`     → ${errorLine}`);
      }

      // Ask whether to continue or stop
      if (config.patches.indexOf(patchEntry) < config.patches.length - 1) {
        const cont = (await prompt("\n  ⚠ Continue applying remaining patches? (y/n): ")).toLowerCase();
        if (cont !== "y") {
          console.log("  Stopped.");
          break;
        }
        console.log("");
      }
    }
  }

  // Clean up temp files
  try {
    const tempFiles = fs.readdirSync(tempDir);
    for (const f of tempFiles) {
      fs.unlinkSync(path.join(tempDir, f));
    }
    fs.rmdirSync(tempDir);
  } catch (e) {
    // ignore cleanup errors
  }

  console.log(`\n  ✅ Done! ${applied} applied, ${failed} failed.`);

  if (failedPatches.length > 0) {
    console.log(`\n  ⚠ Failed patches:`);
    for (const fp of failedPatches) {
      console.log(`     • [${fp.entry.index}] ${fp.entry.shortHash} — ${fp.entry.subject}`);
    }
    console.log(`\n  💡 Tips for resolving conflicts:`);
    console.log(`     1. Apply manually: git am --3way < patch-file.patch`);
    console.log(`     2. Resolve conflicts, then: git am --continue`);
    console.log(`     3. Or skip: git am --skip`);
  }
}

function cmdInfo(configFilePath) {
  const configFileLinux = toLinuxPath(configFilePath);

  if (!fs.existsSync(configFilePath)) {
    console.log(`  ❌ Config file not found: ${configFileLinux}`);
    return;
  }

  const config = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
  const configSize = fs.statSync(configFilePath).size;
  const patchCount = config.patches ? config.patches.length : 0;

  console.log(`
  ┌─────────────────────────────────────────────────────────┐
  │  Git History Transfer — Config Info                     │
  ├─────────────────────────────────────────────────────────┤
  │  File        : ${configFileLinux}
  │  Size        : ${formatSize(configSize)}
  │  Repo        : ${config.repo || "(not set)"}
  ├─────────────────────────────────────────────────────────┤
  │  Commits     : ${config.commits && config.commits.length > 0 ? config.commits.length + " specified" : "(none)"}
  │  Last N      : ${config.lastNCommits || "(not set)"}
  │  Patches     : ${patchCount} stored in config
  │  3-way merge : ${config.options && config.options.threeway ? "enabled" : "disabled"}
  │  Keep author : ${config.options && config.options.keepAuthor !== false ? "yes" : "no"}
  └─────────────────────────────────────────────────────────┘`);

  // Show patches if available
  if (config.patches && config.patches.length > 0) {
    console.log("\n  Stored patches:");
    for (const p of config.patches) {
      console.log(`    ${p.index}. ${p.shortHash} — ${p.subject} (${p.author}, ${p.date})`);
    }
  }

  // Show specified commit hashes if no patches yet
  if (config.commits && config.commits.length > 0 && !config.patches) {
    console.log("\n  Specified commits:");
    for (const h of config.commits) {
      console.log(`    • ${h}`);
    }
  }
}

// =============================================================
// INTERACTIVE MODE
// =============================================================

async function interactiveMode(configFilePath) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  const config = loadConfig(configFilePath);

  if (config) {
    console.log(`  ✔ Config loaded.`);
    console.log(`     Repo    : ${config.repo || "(not set)"}`);
    if (config.commits && config.commits.length > 0) {
      console.log(`     Commits : ${config.commits.length} hash(es)`);
    } else if (config.lastNCommits) {
      console.log(`     Last N  : ${config.lastNCommits} commits`);
    }
    if (config.patches && config.patches.length > 0) {
      console.log(`     Patches : ${config.patches.length} stored`);
    }
  } else {
    console.log(`  ⚠ Config not found. Will create a new one.\n`);
    await cmdInit(configFilePath);
    return;
  }

  console.log("");
  const choice = (
    await prompt("  Choose action — [r]ead / [w]rite / [i]nit / [n]fo: ")
  ).toLowerCase();

  switch (choice) {
    case "r":
    case "read":
      await cmdRead(configFilePath, config);
      break;
    case "w":
    case "write":
      await cmdWrite(configFilePath, config);
      break;
    case "i":
    case "init":
      await cmdInit(configFilePath);
      break;
    case "n":
    case "info":
      cmdInfo(configFilePath);
      break;
    default:
      console.log("  ❌ Invalid choice.");
      break;
  }
}

// =============================================================
// MAIN
// =============================================================

const COMMANDS = ["init", "i", "read", "r", "write", "w", "info", "help", "h"];

async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║     Git History Transfer Utility     ║");
  console.log("╚══════════════════════════════════════╝\n");

  const args = process.argv.slice(2);
  let command = null;
  let configArg = null;

  // Parse arguments
  if (args.length >= 2 && COMMANDS.includes(args[0].toLowerCase())) {
    command = args[0].toLowerCase();
    configArg = args[1];
  } else if (args.length === 1) {
    if (COMMANDS.includes(args[0].toLowerCase())) {
      command = args[0].toLowerCase();
    } else {
      configArg = args[0];
    }
  }

  // Handle help
  if (command === "help" || command === "h") {
    showHelp();
    return;
  }

  // If no config file, prompt for it
  if (!configArg) {
    configArg = await prompt("  📄 Enter config file path (e.g. transfer.json): ");
    if (!configArg) {
      console.log("  ❌ No config file provided. Exiting.");
      process.exit(1);
    }
  }

  const configFilePath = resolveConfigPath(configArg);

  // Dispatch command
  switch (command) {
    case "init":
    case "i":
      await cmdInit(configFilePath);
      break;
    case "read":
    case "r":
      await cmdRead(configFilePath);
      break;
    case "write":
    case "w":
      await cmdWrite(configFilePath);
      break;
    case "info":
      cmdInfo(configFilePath);
      break;
    default:
      await interactiveMode(configFilePath);
      break;
  }
}

main().catch((err) => {
  console.error("  ❌ Error:", err.message);
  process.exit(1);
});
