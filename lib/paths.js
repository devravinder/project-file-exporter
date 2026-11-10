"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function toLinuxPath(p) {
  return p.replace(/\\/g, "/");
}

// Resolve a user-typed path: strips surrounding quotes, expands ~,
// accepts both / and \ on Windows.
function resolvePath(input) {
  let p = String(input).trim().replace(/^["']|["']$/g, "");
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  if (path.sep === "\\") p = p.replace(/\//g, "\\");
  return path.resolve(p);
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a, b) {
  const norm = (p) => {
    let r;
    try {
      r = fs.realpathSync.native(p);
    } catch {
      r = path.resolve(p);
    }
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function isEmptyDir(p) {
  return fs.readdirSync(p).length === 0;
}

module.exports = { toLinuxPath, resolvePath, isDirectory, samePath, isEmptyDir };
