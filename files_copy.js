const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ╔══════════════════════════════════════════════════════════╗
// ║  File Manager Utility — Command-based CLI               ║
// ║                                                         ║
// ║  Usage:                                                 ║
// ║    node start.js <command> <config-file>                ║
// ║    node start.js <config-file>       (interactive)      ║
// ║    node start.js                     (fully prompted)   ║
// ║                                                         ║
// ║  Commands:                                              ║
// ║    init   | i  — Create config file only                ║
// ║    read   | r  — Read files into config                 ║
// ║    create | c  — Create files from config               ║
// ║    info       — Show config file summary                ║
// ║    help   | h  — Show help                              ║
// ╚══════════════════════════════════════════════════════════╝

// =============================================================
// UTILITIES
// =============================================================

function toLinuxPath(p) {
  return p.replace(/\\/g, "/");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function resolveTargetPath(target) {
  const normalized = target.replace(/\//g, path.sep);
  return path.resolve(normalized);
}

// =============================================================
// BINARY DETECTION
// =============================================================

function isBinaryBuffer(buffer) {
  if (buffer.length === 0) return false;

  const checkLength = Math.min(buffer.length, 8192);
  const slice = buffer.slice(0, checkLength);

  // Null byte = definitely binary
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) return true;
  }

  // Definitive test: utf-8 round-trip must preserve bytes
  const asText = slice.toString("utf-8");
  const backToBuffer = Buffer.from(asText, "utf-8");
  if (!slice.equals(backToBuffer)) return true;

  // High non-printable ratio = binary
  let nonPrintable = 0;
  for (let i = 0; i < slice.length; i++) {
    const byte = slice[i];
    if (byte < 8 || (byte > 13 && byte < 32 && byte !== 27)) {
      nonPrintable++;
    }
  }

  return nonPrintable / slice.length > 0.1;
}

// =============================================================
// GLOB / IGNORE MATCHING
// =============================================================

function shouldIgnore(filePath, ignorePatterns) {
  const normalized = toLinuxPath(filePath);
  const segments = normalized.split("/");

  for (const pattern of ignorePatterns) {
    const pat = toLinuxPath(pattern);

    if (pat.startsWith("**/")) {
      const match = pat.slice(3);
      for (const segment of segments) {
        if (globMatch(segment, match)) return true;
      }
      continue;
    }

    if (pat.includes("/")) {
      if (globMatchPath(normalized, pat)) return true;
      continue;
    }

    for (const segment of segments) {
      if (globMatch(segment, pat)) return true;
    }
  }

  return false;
}

function globMatch(str, pattern) {
  const regexStr =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  return new RegExp(regexStr).test(str);
}

function globMatchPath(filePath, pattern) {
  const regexStr =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(.+/)?")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]") +
    "(/.*)?$";
  return new RegExp(regexStr).test(filePath);
}

// =============================================================
// FILE OPERATIONS
// =============================================================

function readAllFiles(dir, baseDir, ignorePatterns, configFilePath) {
  const results = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`  ⚠ Cannot read directory: ${dir}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = toLinuxPath(path.relative(baseDir, fullPath));

    if (shouldIgnore(relativePath, ignorePatterns)) {
      continue;
    }

    const normalizedFull = toLinuxPath(path.resolve(fullPath));
    const normalizedConfig = toLinuxPath(path.resolve(configFilePath));
    if (normalizedFull === normalizedConfig || entry.name === "start.js") {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...readAllFiles(fullPath, baseDir, ignorePatterns, configFilePath));
    } else if (entry.isFile()) {
      try {
        const buffer = fs.readFileSync(fullPath);

        if (isBinaryBuffer(buffer)) {
          results.push({
            path: relativePath,
            encoding: "base64",
            content: buffer.toString("base64"),
          });
          console.log(`  ✔ Read [binary]: ${relativePath} (${formatSize(buffer.length)})`);
        } else {
          results.push({
            path: relativePath,
            encoding: "text",
            content: buffer.toString("utf-8"),
          });
          console.log(`  ✔ Read [text]:   ${relativePath} (${formatSize(buffer.length)})`);
        }
      } catch (err) {
        console.warn(`  ⚠ Skipping: ${relativePath} — ${err.message}`);
      }
    }
  }

  return results;
}

function createFiles(targetDir, files, ignorePatterns) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let created = 0;
  let skipped = 0;

  for (const file of files) {
    if (shouldIgnore(file.path, ignorePatterns)) {
      console.log(`  ⊘ Ignored: ${file.path}`);
      skipped++;
      continue;
    }

    const fullPath = path.join(targetDir, file.path);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (file.encoding === "base64") {
      fs.writeFileSync(fullPath, Buffer.from(file.content, "base64"));
      console.log(`  ✔ Created [binary]: ${file.path}`);
    } else {
      fs.writeFileSync(fullPath, file.content, "utf-8");
      console.log(`  ✔ Created [text]:   ${file.path}`);
    }
    created++;
  }

  return { created, skipped };
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

async function ensureConfig(configFilePath) {
  let config = loadConfig(configFilePath);
  let isNew = false;

  if (!config) {
    console.log("  ⚠ Config file not found. Creating new one.\n");
    config = { target: "", ignore: [], files: [] };
    isNew = true;
  } else {
    console.log("  ✔ Config file loaded.\n");
  }

  // Ask for target if missing
  if (!config.target) {
    const targetInput = await prompt("  📁 Enter target folder path: ");
    if (!targetInput) {
      console.log("  ❌ Target folder is required. Exiting.");
      process.exit(1);
    }
    config.target = toLinuxPath(targetInput);
  } else {
    config.target = toLinuxPath(config.target);
  }

  // Ask for ignore if missing
  if (!config.ignore || config.ignore.length === 0) {
    const ignoreInput = await prompt(
      "  🚫 Enter ignore patterns (comma separated, e.g. **/node_modules,**/dist,.git): "
    );
    if (ignoreInput) {
      config.ignore = ignoreInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      config.ignore = [];
    }
  }

  if (!config.files) {
    config.files = [];
  }

  saveConfig(configFilePath, config);
  return config;
}

// =============================================================
// COMMANDS
// =============================================================

function showHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  File Manager Utility — Help                            ║
╚══════════════════════════════════════════════════════════╝

  Usage:
    node start.js <command> <config-file>
    node start.js <config-file>          (interactive mode)
    node start.js                        (fully prompted)

  Commands:
    init   | i    Create a config file (target + ignore only)
    read   | r    Read all files from target into config
    create | c    Create all files from config into target
    info          Show summary of a config file
    help   | h    Show this help message

  Examples:
    node start.js init project.json
    node start.js read project.json
    node start.js create project.json
    node start.js info project.json
    node start.js project.json

  Config file format (JSON):
    {
      "target": "C:/path/to/project",
      "ignore": ["**/node_modules", "**/dist", ".git"],
      "files": [
        { "path": "src/index.js", "encoding": "text", "content": "..." },
        { "path": "img/logo.png", "encoding": "base64", "content": "..." }
      ]
    }

  Notes:
    - Paths are always stored in linux format (forward slashes)
    - Text files: stored as-is (zero overhead)
    - Binary files: stored as base64 (+33% size)
    - Binary detection is automatic (utf-8 round-trip check)
`);
}

async function cmdInit(configFilePath) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  let config = loadConfig(configFilePath);

  if (config) {
    console.log("  ⚠ Config file already exists.");
    const overwrite = (await prompt("  Overwrite target & ignore? (y/n): ")).toLowerCase();
    if (overwrite !== "y") {
      console.log("  Cancelled.");
      return;
    }
  } else {
    config = { target: "", ignore: [], files: [] };
  }

  // Always ask for target & ignore in init
  const targetInput = await prompt("  📁 Enter target folder path: ");
  if (!targetInput) {
    console.log("  ❌ Target folder is required. Exiting.");
    process.exit(1);
  }
  config.target = toLinuxPath(targetInput);

  const ignoreInput = await prompt(
    "  🚫 Enter ignore patterns (comma separated, e.g. **/node_modules,**/dist,.git): "
  );
  if (ignoreInput) {
    config.ignore = ignoreInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    config.ignore = [];
  }

  if (!config.files) {
    config.files = [];
  }

  saveConfig(configFilePath, config);

  console.log(`\n  ✅ Config file created!`);
  console.log(`     Target : ${config.target}`);
  console.log(`     Ignore : ${config.ignore.join(", ") || "(none)"}`);
  console.log(`     Saved  : ${configFileLinux}`);
}

async function cmdRead(configFilePath, existingConfig) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  const config = existingConfig || (await ensureConfig(configFilePath));
  const targetFsPath = resolveTargetPath(config.target);

  if (!fs.existsSync(targetFsPath)) {
    console.error(`\n  ❌ Target folder does not exist: ${toLinuxPath(targetFsPath)}`);
    return;
  }

  console.log(`\n  📖 Reading files from: ${toLinuxPath(targetFsPath)}\n`);

  const allFiles = readAllFiles(targetFsPath, targetFsPath, config.ignore, configFilePath);

  const textCount = allFiles.filter((f) => f.encoding === "text").length;
  const binaryCount = allFiles.filter((f) => f.encoding === "base64").length;

  config.files = allFiles;
  saveConfig(configFilePath, config);

  const configSize = fs.statSync(configFilePath).size;

  console.log(`\n  ✅ Done! ${allFiles.length} files saved.`);
  console.log(`     📝 Text: ${textCount} | 📦 Binary: ${binaryCount}`);
  console.log(`     Config size: ${formatSize(configSize)}`);
  console.log(`     Saved at: ${configFileLinux}`);
}

async function cmdCreate(configFilePath, existingConfig) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  const config = existingConfig || (await ensureConfig(configFilePath));

  if (config.files.length === 0) {
    console.log("  ⚠ No files found in config. Run 'read' first.");
    return;
  }

  const targetFsPath = resolveTargetPath(config.target);

  console.log(`\n  📁 Creating files in: ${toLinuxPath(targetFsPath)}\n`);

  const { created, skipped } = createFiles(targetFsPath, config.files, config.ignore);

  console.log(`\n  ✅ Done! ${created} files created, ${skipped} skipped.`);
}

function cmdInfo(configFilePath) {
  const configFileLinux = toLinuxPath(configFilePath);

  if (!fs.existsSync(configFilePath)) {
    console.log(`  ❌ Config file not found: ${configFileLinux}`);
    return;
  }

  const config = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
  const configSize = fs.statSync(configFilePath).size;

  const files = config.files || [];
  const textFiles = files.filter((f) => f.encoding === "text");
  const binaryFiles = files.filter((f) => f.encoding === "base64");

  const textSize = textFiles.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf-8"), 0);
  const binaryOriginalSize = binaryFiles.reduce(
    (sum, f) => sum + Math.floor((f.content.length * 3) / 4),
    0
  );

  console.log(`
  ┌─────────────────────────────────────────────────┐
  │  Config Info                                    │
  ├─────────────────────────────────────────────────┤
  │  File     : ${configFileLinux}
  │  Target   : ${config.target || "(not set)"}
  │  Ignore   : ${(config.ignore || []).join(", ") || "(none)"}
  ├─────────────────────────────────────────────────┤
  │  Total files   : ${files.length}
  │  Text files    : ${textFiles.length} (${formatSize(textSize)})
  │  Binary files  : ${binaryFiles.length} (${formatSize(binaryOriginalSize)} original)
  │  Config size   : ${formatSize(configSize)}
  └─────────────────────────────────────────────────┘`);

  if (files.length > 0 && files.length <= 30) {
    console.log("\n  Files:");
    for (const f of files) {
      const icon = f.encoding === "base64" ? "📦" : "📝";
      console.log(`    ${icon} ${f.path}`);
    }
  } else if (files.length > 30) {
    console.log(`\n  Files (showing first 30 of ${files.length}):`);
    for (let i = 0; i < 30; i++) {
      const f = files[i];
      const icon = f.encoding === "base64" ? "📦" : "📝";
      console.log(`    ${icon} ${f.path}`);
    }
    console.log(`    ... and ${files.length - 30} more`);
  }
}

// =============================================================
// INTERACTIVE MODE (backward compatible)
// =============================================================

async function interactiveMode(configFilePath) {
  const configFileLinux = toLinuxPath(configFilePath);
  console.log(`  Config file: ${configFileLinux}\n`);

  const config = await ensureConfig(configFilePath);

  const targetDir = path.isAbsolute(config.target)
    ? config.target
    : toLinuxPath(path.resolve(process.cwd(), config.target));

  console.log(`\n  Target folder  : ${targetDir}`);
  console.log(`  Ignore patterns: ${config.ignore.join(", ")}`);
  console.log(`  Files in JSON  : ${config.files.length}\n`);

  const choice = (
    await prompt("  Choose action — [r]ead / [c]reate / [i]nit / [n]fo: ")
  ).toLowerCase();

  switch (choice) {
    case "r":
    case "read":
      await cmdRead(configFilePath, config);
      break;
    case "c":
    case "create":
      await cmdCreate(configFilePath, config);
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

const COMMANDS = ["init", "i", "read", "r", "create", "c", "info", "help", "h"];

async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       File Manager Utility           ║");
  console.log("╚══════════════════════════════════════╝\n");

  const args = process.argv.slice(2);
  let command = null;
  let configArg = null;

  // Parse arguments
  if (args.length >= 2 && COMMANDS.includes(args[0].toLowerCase())) {
    // node start.js <command> <config-file>
    command = args[0].toLowerCase();
    configArg = args[1];
  } else if (args.length === 1) {
    if (COMMANDS.includes(args[0].toLowerCase())) {
      // node start.js help
      command = args[0].toLowerCase();
    } else {
      // node start.js <config-file> (interactive)
      configArg = args[0];
    }
  }

  // Handle help
  if (command === "help" || command === "h") {
    showHelp();
    return;
  }

  // If no config file, prompt for it (unless help)
  if (!configArg) {
    configArg = await prompt("  📄 Enter config file path (e.g. files.json): ");
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
    case "create":
    case "c":
      await cmdCreate(configFilePath);
      break;
    case "info":
      cmdInfo(configFilePath);
      break;
    default:
      // No command = interactive mode
      await interactiveMode(configFilePath);
      break;
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
