"use strict";

const prompt = require("./prompt");

// Flags that never take a value.
const BOOLEAN_FLAGS = new Set(["yes", "overwrite", "help"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y") {
      flags.yes = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function hasFlag(flags, name) {
  return flags[name] !== undefined && flags[name] !== true;
}

// Take a value from --name, or ask for it. `parse` converts / validates and
// throws on bad input: a bad flag aborts, a bad answer re-asks.
async function option(flags, name, question, { def, parse, optional = false } = {}) {
  if (hasFlag(flags, name)) return parse ? parse(String(flags[name])) : String(flags[name]);
  for (;;) {
    const hint = def !== undefined ? ` [${def}]` : optional ? " [Enter to skip]" : "";
    let answer = await prompt.ask(`  ${question}${hint}: `);
    if (answer === "" && def !== undefined) answer = String(def);
    if (answer === "") {
      if (optional) return null;
      console.log("  ⚠ A value is required.");
      continue;
    }
    try {
      return parse ? parse(answer) : answer;
    } catch (e) {
      console.log(`  ⚠ ${e.message}`);
    }
  }
}

// y/n question that honours --yes.
async function confirm(flags, question, def = true) {
  if (flags.yes) return true;
  return prompt.confirm(`  ${question}`, def);
}

module.exports = { parseArgs, hasFlag, option, confirm };
