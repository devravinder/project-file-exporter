"use strict";

const fs = require("fs");
const path = require("path");
const prompt = require("../lib/prompt");
const { option, confirm } = require("../lib/args");
const { formatSize } = require("../lib/size");
const { resolvePath, isDirectory, toLinuxPath } = require("../lib/paths");
const { loadParts } = require("../lib/assemble");

// Reject paths that could escape the destination (absolute, "..", drive letters).
function safeTarget(dest, rel) {
  const target = path.resolve(dest, rel);
  const inside = target === dest || target.startsWith(dest + path.sep);
  if (!inside || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`Refusing unsafe path in export: ${rel}`);
  }
  return target;
}

async function run(flags) {
  const partsDir = await option(flags, "parts", "📥 Folder with the part files", {
    parse: (v) => {
      const d = resolvePath(v);
      if (!isDirectory(d)) throw new Error(`Not a folder: ${d}`);
      return d;
    },
  });
  const pkg = await loadParts(partsDir, { kind: "files", flags });
  const manifest = pkg.entries.find((e) => e.meta.type === "manifest").meta;
  const files = pkg.entries.filter((e) => e.meta.type === "file");
  const total = files.reduce((n, f) => n + f.data.length, 0);

  console.log(`\n  ✔ Export ${pkg.exportId}: ${pkg.total} part(s) verified`);
  console.log(`     ${files.length} file(s), ${formatSize(total)}, from "${manifest.source}"`);

  const dest = await option(flags, "dest", "🎯 Destination folder (created if missing)", { parse: resolvePath });
  if (fs.existsSync(dest) && !isDirectory(dest)) throw new Error(`Not a folder: ${dest}`);

  const targets = files.map((f) => ({ f, target: safeTarget(dest, f.meta.path) }));
  const existing = targets.filter((t) => fs.existsSync(t.target));

  let overwrite = true;
  if (existing.length) {
    console.log(`\n  ⚠ ${existing.length} file(s) already exist in the destination.`);
    if (flags.overwrite || flags.yes) {
      overwrite = true;
    } else {
      const choice = await prompt.menu("Existing files?", [
        { label: "Overwrite them", value: "overwrite" },
        { label: "Keep them (skip those files)", value: "skip" },
      ], "q) Cancel");
      if (!choice) throw new Error("Cancelled.");
      overwrite = choice === "overwrite";
    }
  }
  if (!(await confirm(flags, `Write files into ${toLinuxPath(dest)}?`, true))) throw new Error("Cancelled.");

  let created = 0;
  let skipped = 0;
  for (const { f, target } of targets) {
    if (!overwrite && fs.existsSync(target)) {
      skipped++;
      console.log(`  ⊘ kept existing: ${f.meta.path}`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
    if (f.meta.mode !== undefined && process.platform !== "win32") fs.chmodSync(target, f.meta.mode);
    if (f.meta.mtime) {
      const t = new Date(f.meta.mtime);
      fs.utimesSync(target, t, t);
    }
    created++;
    console.log(`  ✔ ${formatSize(f.data.length).padStart(9)}  ${f.meta.path}`);
  }
  console.log(`\n  ✅ ${created} file(s) written${skipped ? `, ${skipped} kept` : ""}.`);
}

module.exports = { run };
