"use strict";

// Parse a size string. A bare number is KB ("350" → 350 KB).
// Units honoured when present: "350kb", "1.5mb", "500000b".
function parseSize(input) {
  const s = String(input || "").trim().toLowerCase().replace(/\s+/g, "");
  const match = s.match(/^(\d+(?:\.\d+)?)(b|kb|k|mb|m|gb|g)?$/);
  if (!match) throw new Error(`Invalid size "${input}". Use e.g. 350, 350kb, 1.5mb.`);
  const mult = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 };
  const bytes = Math.round(parseFloat(match[1]) * mult[match[2] || "kb"]);
  if (!(bytes > 0)) throw new Error("Size must be greater than zero.");
  return bytes;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { parseSize, formatSize };
