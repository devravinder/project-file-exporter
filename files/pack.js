"use strict";

const fs = require("fs");
const path = require("path");
const { option } = require("../lib/args");
const { parseSize, formatSize } = require("../lib/size");
const { resolvePath, isDirectory, toLinuxPath, DEFAULT_DIR } = require("../lib/paths");
const { packEntries, writeParts } = require("../lib/packer");
const { prepareOutDir } = require("../lib/assemble");
const { compileIgnore } = require("./ignore");

function scan(root, isIgnored, skipDir) {
  const found = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.log(`  ⚠ Cannot read folder ${toLinuxPath(dir)}: ${e.message}`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = toLinuxPath(path.relative(root, full));
      if (isIgnored(rel)) continue;
      if (e.isDirectory()) {
        if (skipDir && path.resolve(full) === skipDir) continue;
        walk(full);
      } else if (e.isFile()) {
        found.push({ rel, full });
      }
    }
  })(root);
  return found;
}

async function run(flags) {
  const src = await option(flags, "src", "📁 Source folder", {
    parse: (v) => {
      const d = resolvePath(v);
      if (!isDirectory(d)) throw new Error(`Not a folder: ${d}`);
      return d;
    },
  });
  const ignoreText = await option(flags, "ignore", "🚫 Ignore patterns (comma separated, 'none' for nothing)", {
    def: ".git,node_modules",
  });
  const ignore = ignoreText.toLowerCase() === "none" ? [] : ignoreText.split(",");
  const limit = await option(flags, "limit", "📏 Max size per part file (KB)", { def: "350", parse: parseSize });
  const outDir = await option(flags, "out", "💾 Output folder", { def: DEFAULT_DIR, parse: resolvePath });

  await prepareOutDir(outDir, flags);

  const files = scan(src, compileIgnore(ignore), outDir);
  if (files.length === 0) throw new Error("No files found to pack.");

  console.log(`\n  Reading ${files.length} file(s)...\n`);
  const items = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f.full);
      const data = fs.readFileSync(f.full);
      const meta = { type: "file", path: f.rel, mtime: Math.floor(st.mtimeMs) };
      if (process.platform !== "win32") meta.mode = st.mode & 0o777;
      items.push({ meta, data });
      console.log(`  ✔ ${formatSize(data.length).padStart(9)}  ${f.rel}`);
    } catch (e) {
      console.log(`  ⚠ Skipped ${f.rel}: ${e.message}`);
    }
  }
  if (items.length === 0) throw new Error("No file could be read.");

  items.unshift({
    meta: { type: "manifest", kind: "files", created: new Date().toISOString(), source: path.basename(src), fileCount: items.length },
    data: Buffer.alloc(0),
  });

  console.log("\n  Packing...");
  const packed = packEntries(items, limit);
  const written = writeParts(outDir, "files", packed, limit);

  console.log(`\n  ✅ ${items.length - 1} file(s) → ${written.length} part file(s) in ${toLinuxPath(outDir)}\n`);
  for (const w of written) {
    console.log(`     ${path.basename(w.file)}  ${formatSize(w.size).padStart(9)}  (${Math.round((w.size / limit) * 100)}% of limit)`);
  }
  for (const [eid, n] of packed.sliced) {
    console.log(`\n  ✂ ${items[eid].meta.path} is large and was split across ${n} part(s) (restored automatically).`);
  }
  console.log("\n  Copy the part files to the destination, then run: files → Unpack.");
}

module.exports = { run };
