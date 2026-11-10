"use strict";

const fs = require("fs");
const path = require("path");
const prompt = require("./prompt");
const { hasFlag, confirm } = require("./args");
const { parsePart, looksLikePart, sha256 } = require("./packer");

function partFilesIn(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(dir, d.name))
    .filter(looksLikePart)
    .sort();
}

// Before exporting: make sure old parts in the folder cannot mix with the new ones.
async function prepareOutDir(outDir, flags) {
  if (!fs.existsSync(outDir)) return;
  const old = partFilesIn(outDir);
  if (old.length === 0) return;
  const ok = await confirm(flags, `${old.length} part file(s) from an earlier export are in this folder. Delete them?`, false);
  if (!ok) throw new Error("Choose another output folder or allow deleting the old parts.");
  for (const f of old) fs.unlinkSync(f);
}

function verifyEntry(meta, data) {
  if (data.length !== meta.dataSize || sha256(data) !== meta.dataSha256) {
    throw new Error(`Entry #${meta.eid} failed verification (size/checksum) after joining its slices.`);
  }
}

// Join sliced entries back together (in order of first appearance).
function reassemble(orderedParts) {
  const out = [];
  const slots = new Map();
  for (const part of orderedParts) {
    for (const e of part.entries) {
      if (!e.meta.slice) {
        verifyEntry(e.meta, e.data);
        out.push({ meta: e.meta, data: e.data });
        continue;
      }
      let s = slots.get(e.meta.eid);
      if (!s) {
        s = { meta: e.meta, pieces: [], n: e.meta.slice.n, pos: out.length };
        slots.set(e.meta.eid, s);
        out.push(null);
      }
      s.pieces[e.meta.slice.i] = e.data;
    }
  }
  for (const s of slots.values()) {
    for (let i = 0; i < s.n; i++) {
      if (!s.pieces[i]) throw new Error(`Entry #${s.meta.eid}: slice ${i + 1}/${s.n} is missing.`);
    }
    const data = Buffer.concat(s.pieces);
    verifyEntry(s.meta, data);
    const { slice, ...meta } = s.meta;
    out[s.pos] = { meta, data };
  }
  return out;
}

// Read every part in `dir`, verify them, pick one export, and return its entries.
async function loadParts(dir, { kind, flags = {} }) {
  const parts = [];
  const problems = [];
  for (const file of partFilesIn(dir)) {
    const name = path.basename(file);
    try {
      parts.push({ name, ...parsePart(fs.readFileSync(file, "utf8")) });
    } catch (e) {
      if (e.code !== "NOT_PART") problems.push(`${name}: ${e.message}`);
    }
  }

  const groups = new Map();
  for (const p of parts) {
    if (!groups.has(p.header.exportId)) groups.set(p.header.exportId, []);
    groups.get(p.header.exportId).push(p);
  }

  const problemText = problems.length ? "\n  Problem files:\n" + problems.map((p) => `    - ${p}`).join("\n") : "";
  if (groups.size === 0) throw new Error(`No valid part files found in ${dir}.${problemText}`);

  let chosen;
  if (hasFlag(flags, "export-id")) {
    chosen = groups.get(String(flags["export-id"]));
    if (!chosen) throw new Error(`No export with id ${flags["export-id"]} in this folder.`);
  } else if (groups.size === 1) {
    chosen = [...groups.values()][0];
  } else {
    const items = [...groups.entries()].map(([id, g]) => ({
      label: `${id}  ${g[0].header.kind}  created ${g[0].header.created}  (${g.length}/${g[0].header.total} parts)`,
      value: id,
    }));
    console.log("\n  ⚠ The folder contains parts of more than one export.");
    const id = await prompt.menu("Which export?", items);
    if (!id) throw new Error("Cancelled.");
    chosen = groups.get(id);
  }

  const { exportId, total, created, kind: foundKind } = chosen[0].header;
  if (foundKind !== kind) {
    throw new Error(`This export contains "${foundKind}" data, but "${kind}" was expected.`);
  }

  const bySeq = new Map();
  for (const p of chosen) {
    const prev = bySeq.get(p.header.seq);
    if (prev && prev.header.sha256 !== p.header.sha256) {
      throw new Error(`Parts ${prev.name} and ${p.name} both claim to be part ${p.header.seq} but differ.`);
    }
    bySeq.set(p.header.seq, prev || p);
  }
  const missing = [];
  for (let s = 1; s <= total; s++) if (!bySeq.has(s)) missing.push(s);
  if (missing.length) {
    throw new Error(`Missing part(s): ${missing.join(", ")} of ${total}.${problemText}`);
  }
  if (problems.length) console.log(`  ⚠ Ignored unreadable file(s):\n${problems.map((p) => `    - ${p}`).join("\n")}`);

  const ordered = [...bySeq.keys()].sort((a, b) => a - b).map((s) => bySeq.get(s));
  return { exportId, total, created, entries: reassemble(ordered) };
}

module.exports = { loadParts, prepareOutDir, partFilesIn };
