const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ╔══════════════════════════════════════════════════════════╗
// ║  Splitter — split a file into size-limited parts         ║
// ║                                                          ║
// ║  Usage:                                                  ║
// ║    node splitter.js                                      ║
// ║                                                          ║
// ║  Flow:                                                   ║
// ║    1. Ask for file path                                  ║
// ║    2. Ask for size limit (in KB)                         ║
// ║    3. Read file as text, split into <size> KB parts      ║
// ║       → name-1.ext, name-2.ext, ...                      ║
// ╚══════════════════════════════════════════════════════════╝

// =============================================================
// UTILITIES
// =============================================================

function toLinuxPath(p) {
  return p.replace(/\\/g, "/");
}

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

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// Parse a size string. A bare number is treated as KB (e.g. "300" → 300 KB).
// Units honored when present: "300kb", "1.5mb", "500000b".
function parseSize(input) {
  if (!input) return NaN;
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = s.match(/^([\d.]+)\s*(b|kb|k|mb|m|gb|g)?$/);
  if (!match) return NaN;
  const value = parseFloat(match[1]);
  if (isNaN(value)) return NaN;
  const unit = match[2] || "kb"; // default KB
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

// Split a string into chunks where each chunk's UTF-8 byte length is at most
// maxBytes. Splits on character boundaries so multi-byte characters are never
// cut in half.
function splitByBytes(content, maxBytes) {
  const chunks = [];
  let start = 0;
  const len = content.length;

  while (start < len) {
    // Estimate an end index, then shrink until the byte length fits.
    let end = Math.min(len, start + maxBytes);
    while (
      end > start &&
      Buffer.byteLength(content.slice(start, end), "utf-8") > maxBytes
    ) {
      end--;
    }
    // Safety: always make progress even if a single char exceeds maxBytes.
    if (end === start) end = start + 1;
    chunks.push(content.slice(start, end));
    start = end;
  }

  return chunks;
}

// Build output file name: <base>-<n><ext> next to the source file.
function partName(dir, base, ext, n) {
  return path.join(dir, `${base}-${n}${ext}`);
}

// =============================================================
// MAIN
// =============================================================

async function doSplit() {
  // 1. File path
  const fileInput = await prompt("  📄 Enter file path (or 'q' to quit): ");
  if (!fileInput || fileInput.toLowerCase() === "q") {
    console.log("  👋 Bye.");
    return;
  }

  const filePath = resolvePath(fileInput);

  if (!fs.existsSync(filePath)) {
    console.log(`  ❌ File does not exist: ${toLinuxPath(filePath)}`);
    return;
  }
  if (!fs.statSync(filePath).isFile()) {
    console.log(`  ❌ Not a file: ${toLinuxPath(filePath)}`);
    return;
  }

  // 2. Size limit (KB)
  const sizeInput = await prompt("  📏 Max size per part in KB (e.g. 300): ");
  const maxBytes = parseSize(sizeInput);
  if (isNaN(maxBytes) || maxBytes <= 0) {
    console.log("  ❌ Invalid size.");
    return;
  }

  // 3. Read file as text and split
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    console.log(`  ❌ Failed to read file: ${e.message}`);
    return;
  }

  const totalBytes = Buffer.byteLength(content, "utf-8");
  console.log(`\n  Source : ${toLinuxPath(filePath)}`);
  console.log(`  Size   : ${formatKB(totalBytes)}`);
  console.log(`  Limit  : ${formatKB(maxBytes)} per part\n`);

  if (totalBytes <= maxBytes) {
    console.log("  ℹ File is already within the size limit — nothing to split.");
    return;
  }

  const chunks = splitByBytes(content, maxBytes);

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath); // includes leading "."
  const base = path.basename(filePath, ext);

  const written = [];
  for (let i = 0; i < chunks.length; i++) {
    const outPath = partName(dir, base, ext, i + 1);
    try {
      fs.writeFileSync(outPath, chunks[i], "utf-8");
      const bytes = Buffer.byteLength(chunks[i], "utf-8");
      written.push({ outPath, bytes });
      console.log(`  ✔ ${toLinuxPath(outPath)}  (${formatKB(bytes)})`);
    } catch (e) {
      console.log(`  ❌ Failed to write ${toLinuxPath(outPath)}: ${e.message}`);
    }
  }

  console.log(`\n  ✅ Done! Split into ${written.length} part(s).`);
}

async function doCombine() {
  // 1. List of input files (comma separated), in order.
  const listInput = await prompt("  📄 Enter files to combine (comma separated, in order): ");
  const parts = listInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    console.log("  ❌ No files provided.");
    return;
  }

  // Validate every file first.
  const resolved = [];
  for (const p of parts) {
    const fp = resolvePath(p);
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      console.log(`  ❌ Not a valid file: ${toLinuxPath(fp)}`);
      return;
    }
    resolved.push(fp);
  }

  // 2. Output file path.
  const outInput = await prompt("  💾 Enter output file path: ");
  if (!outInput) {
    console.log("  ❌ Output file path is required.");
    return;
  }
  const outPath = resolvePath(outInput);

  // 3. Read each part as text and concatenate in the given order.
  let combined = "";
  console.log("");
  for (const fp of resolved) {
    try {
      const data = fs.readFileSync(fp, "utf-8");
      combined += data;
      console.log(`  ✔ ${toLinuxPath(fp)}  (${formatKB(Buffer.byteLength(data, "utf-8"))})`);
    } catch (e) {
      console.log(`  ❌ Failed to read ${toLinuxPath(fp)}: ${e.message}`);
      return;
    }
  }

  try {
    fs.writeFileSync(outPath, combined, "utf-8");
  } catch (e) {
    console.log(`  ❌ Failed to write output: ${e.message}`);
    return;
  }

  const totalBytes = Buffer.byteLength(combined, "utf-8");
  console.log(`\n  ✅ Done! Combined ${resolved.length} file(s) → ${toLinuxPath(outPath)} (${formatKB(totalBytes)}).`);
}

async function main() {
  console.log("\n  =============== File Splitter ===============\n");
  console.log("    1) Split  — split a file into size-limited parts");
  console.log("    2) Combine — join multiple files into one");
  console.log("    q) Quit");

  const choice = (await prompt("\n  Select an option: ")).toLowerCase();

  switch (choice) {
    case "1":
    case "split":
      await doSplit();
      break;
    case "2":
    case "combine":
      await doCombine();
      break;
    case "q":
    case "quit":
      console.log("  👋 Bye.");
      break;
    default:
      console.log("  ❌ Invalid option.");
      break;
  }

  rl.close();
}

main().catch((err) => {
  console.error("  ❌ Error:", err.message);
  rl.close();
  process.exit(1);
});
