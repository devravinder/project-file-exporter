"use strict";

const { toLinuxPath } = require("../lib/paths");

// glob → regex source. `*` stays inside one path segment, `**` crosses segments.
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return re;
}

// Patterns:  node_modules   *.log   **/dist   build/out
//  - without "/"  → matches a file/folder name at any depth
//  - with "/"     → matches from the root (or anywhere if it starts with **/)
//  - a match on a folder excludes everything inside it
function compileIgnore(patterns) {
  const rules = [];
  for (let p of patterns) {
    p = toLinuxPath(String(p).trim()).replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p) continue;
    let anywhere = false;
    if (p.startsWith("**/")) {
      p = p.slice(3);
      anywhere = true;
    }
    if (!p.includes("/")) anywhere = true;
    rules.push({ re: new RegExp(`^${globToRegex(p)}$`), anywhere });
  }

  return function isIgnored(relPath) {
    const segs = toLinuxPath(relPath).split("/");
    for (const { re, anywhere } of rules) {
      for (let s = 0; s < (anywhere ? segs.length : 1); s++) {
        for (let e = s + 1; e <= segs.length; e++) {
          if (re.test(segs.slice(s, e).join("/"))) return true;
        }
      }
    }
    return false;
  };
}

module.exports = { compileIgnore };
