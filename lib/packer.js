"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { formatSize } = require("./size");

// ─────────────────────────────────────────────────────────────
// Part file format (JSON, "gt1"):
//
//   { "format": "gt1", "kind": "git"|"files", "exportId": "...",
//     "created": "...", "seq": 3, "total": 7, "sha256": "<of gzip bytes>",
//     "encoding": "gzip+base64", "data": ["<base64 line>", ...] }
//
// `data` decodes (base64 → gunzip) into a sequence of entries:
//   [u32 metaLen][meta JSON][u32 dataLen][raw bytes]
// An entry too big for one part is cut into slices (meta.slice = {i, n});
// the loader joins them again and verifies size + sha256.
// ─────────────────────────────────────────────────────────────

const FORMAT = "gt1";
const LINE = 120; // base64 chars per line inside "data"
const LINE_COST = LINE + 8; // + indent(4) quotes(2) comma(1) newline(1)
const HEADER_RESERVE = 512; // bytes kept for the JSON header
const MIN_LIMIT = 8 * 1024;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function gzip(buf) {
  return zlib.gzipSync(buf, { level: 6 });
}

function newExportId() {
  return crypto.randomBytes(6).toString("hex");
}

// ── entries ──────────────────────────────────────────────────

function encodeEntry(meta, data) {
  const m = Buffer.from(JSON.stringify(meta), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(m.length);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([head, m, len, data]);
}

function decodePayload(buf) {
  const entries = [];
  let p = 0;
  while (p < buf.length) {
    const ml = buf.readUInt32BE(p);
    p += 4;
    const meta = JSON.parse(buf.toString("utf8", p, p + ml));
    p += ml;
    const dl = buf.readUInt32BE(p);
    p += 4;
    entries.push({ meta, data: buf.subarray(p, p + dl) });
    p += dl;
  }
  return entries;
}

// ── packing ──────────────────────────────────────────────────

// Largest gzip payload whose finished part file stays within `limit` bytes.
function maxGzBytes(limit) {
  const b64Chars = Math.floor(((limit - HEADER_RESERVE) * LINE) / LINE_COST);
  return Math.floor(Math.floor(b64Chars / 4) * 3 * 0.99); // 1% safety margin
}

// How many entries (from `start`) fit in one part? Gallop, then bisect, so
// only O(log n) compressions are needed per part.
function fitBest(queue, start, maxGz) {
  const n = queue.length - start;
  const attempt = (k) => {
    const gz = gzip(Buffer.concat(queue.slice(start, start + k).map((e) => e.enc)));
    return gz.length <= maxGz ? gz : null;
  };
  let lo = 0;
  let loGz = null;
  let hi = null;
  let k = 1;
  while (k <= n) {
    const gz = attempt(k);
    if (gz) {
      lo = k;
      loGz = gz;
      k *= 2;
    } else {
      hi = k;
      break;
    }
  }
  if (hi === null && lo < n) {
    const gz = attempt(n);
    if (gz) {
      lo = n;
      loGz = gz;
    } else {
      hi = n;
    }
  }
  if (hi !== null) {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const gz = attempt(mid);
      if (gz) {
        lo = mid;
        loGz = gz;
      } else {
        hi = mid;
      }
    }
  }
  return { count: lo, gz: loGz };
}

// Cut one oversized entry into slices that each fit in a part on their own.
function sliceEntry(entry, maxGz) {
  const total = entry.data.length;
  const ratio = Math.max(gzip(entry.enc).length / entry.enc.length, 0.01);
  let size = Math.max(1024, Math.floor((maxGz / ratio) * 0.95));
  const ranges = [];
  let pos = 0;
  while (pos < total) {
    let len = Math.min(size, total - pos);
    for (;;) {
      const meta = { ...entry.meta, slice: { i: ranges.length, n: 999999 } };
      const enc = encodeEntry(meta, entry.data.subarray(pos, pos + len));
      if (gzip(enc).length <= maxGz) break;
      if (len <= 1) throw new Error("Cannot fit data into the size limit - raise the limit.");
      len = Math.max(1, Math.floor(len * 0.85));
    }
    ranges.push([pos, len]);
    pos += len;
    size = len;
  }
  return ranges.map(([p, l], i) => {
    const meta = { ...entry.meta, slice: { i, n: ranges.length } };
    const data = entry.data.subarray(p, p + l);
    return { meta, data, enc: encodeEntry(meta, data) };
  });
}

// items: [{ meta, data: Buffer }] → { parts: [{gz, entries}], sliced: Map(eid → slices) }
// Each item gets meta.eid (its index) plus dataSize / dataSha256 for verification.
function packEntries(items, limit) {
  if (limit < MIN_LIMIT) throw new Error(`Size limit too small (minimum ${formatSize(MIN_LIMIT)}).`);
  const maxGz = maxGzBytes(limit);

  const queue = items.map((it, eid) => {
    const meta = { ...it.meta, eid, dataSize: it.data.length, dataSha256: sha256(it.data) };
    return { meta, data: it.data, enc: encodeEntry(meta, it.data) };
  });

  const parts = [];
  const sliced = new Map();
  let i = 0;
  while (i < queue.length) {
    const fit = fitBest(queue, i, maxGz);
    if (fit.count === 0) {
      const e = queue[i];
      if (e.meta.slice) throw new Error("Internal error: a slice does not fit in a part.");
      const slices = sliceEntry(e, maxGz);
      sliced.set(e.meta.eid, slices.length);
      queue.splice(i, 1, ...slices);
      continue;
    }
    parts.push({ gz: fit.gz, entries: queue.slice(i, i + fit.count).map((e) => e.meta) });
    i += fit.count;
  }
  return { parts, sliced };
}

// ── writing ──────────────────────────────────────────────────

function renderPart({ kind, exportId, created, seq, total, gz }) {
  const b64 = gz.toString("base64");
  const lines = [];
  for (let i = 0; i < b64.length; i += LINE) lines.push(b64.slice(i, i + LINE));
  const header = {
    format: FORMAT,
    kind,
    exportId,
    created,
    seq,
    total,
    sha256: sha256(gz),
    encoding: "gzip+base64",
  };
  let text = "{\n";
  for (const [k, v] of Object.entries(header)) text += `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`;
  text += '  "data": [\n';
  text += lines.map((l, i) => `    "${l}"${i < lines.length - 1 ? "," : ""}\n`).join("");
  text += "  ]\n}\n";
  return text;
}

function partFileName(seq, total) {
  const w = Math.max(4, String(total).length);
  return `${String(seq).padStart(w, "0")}-of-${String(total).padStart(w, "0")}.json`;
}

// Write all parts into outDir. Returns [{ file, size, entries }].
function writeParts(outDir, kind, packed, limit) {
  fs.mkdirSync(outDir, { recursive: true });
  const exportId = newExportId();
  const created = new Date().toISOString();
  const total = packed.parts.length;
  return packed.parts.map((part, i) => {
    const text = renderPart({ kind, exportId, created, seq: i + 1, total, gz: part.gz });
    const size = Buffer.byteLength(text, "utf8");
    if (size > limit) throw new Error(`Internal error: part ${i + 1} is ${formatSize(size)} (> limit).`);
    const file = path.join(outDir, partFileName(i + 1, total));
    fs.writeFileSync(file, text, "utf8");
    return { file, size, entries: part.entries };
  });
}

// ── reading ──────────────────────────────────────────────────

function partError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Parse + verify one part file's text. Throws with .code NOT_PART / CORRUPT.
function parsePart(text) {
  let obj;
  try {
    obj = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw partError("CORRUPT", "not valid JSON - the copy is probably incomplete");
  }
  if (!obj || obj.format !== FORMAT) throw partError("NOT_PART", "not a transfer part file");
  if (
    typeof obj.exportId !== "string" ||
    !Number.isInteger(obj.seq) ||
    !Number.isInteger(obj.total) ||
    !Array.isArray(obj.data)
  ) {
    throw partError("CORRUPT", "header fields are missing");
  }
  const gz = Buffer.from(obj.data.join("").replace(/\s+/g, ""), "base64");
  if (sha256(gz) !== obj.sha256) {
    throw partError("CORRUPT", "checksum mismatch - data was changed or cut off while copying");
  }
  let entries;
  try {
    entries = decodePayload(zlib.gunzipSync(gz));
  } catch {
    throw partError("CORRUPT", "payload cannot be decompressed");
  }
  const { data, ...header } = obj;
  return { header, entries };
}

// Quick check (first bytes only) so unrelated files in a folder are skipped cheaply.
const PART_PROBE = /"format"\s*:\s*"gt1"/;

function looksLikePart(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return PART_PROBE.test(buf.toString("utf8", 0, n));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { packEntries, writeParts, parsePart, looksLikePart, sha256 };
