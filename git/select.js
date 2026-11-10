"use strict";

const prompt = require("../lib/prompt");
const { hasFlag, option } = require("../lib/args");
const { listCommits } = require("./repo");

const MODES = ["all", "last", "unpushed", "hashes"];

// Ask (or read from --mode / --count / --hashes) which commits to work on.
async function chooseCommits(flags, repoDir) {
  let mode = hasFlag(flags, "mode") ? String(flags.mode).toLowerCase() : null;
  if (mode && !MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  if (!mode) {
    mode = await prompt.menu(
      "Which commits?",
      [
        { label: "All commits", value: "all" },
        { label: "Last N commits", value: "last" },
        { label: "Unpushed commits (not on any remote)", value: "unpushed" },
        { label: "Specific commits (hashes)", value: "hashes" },
      ],
      "q) Cancel"
    );
    if (!mode) throw new Error("Cancelled.");
  }

  const sel = { mode };
  if (mode === "last") {
    sel.count = await option(flags, "count", "How many recent commits (N)?", {
      parse: (v) => {
        const n = parseInt(v, 10);
        if (!(n > 0)) throw new Error("Enter a positive number.");
        return n;
      },
    });
  }
  if (mode === "hashes") {
    sel.hashes = await option(flags, "hashes", "Commit hashes (comma separated)", {
      parse: (v) => {
        const list = v.split(",").map((s) => s.trim()).filter(Boolean);
        if (!list.length) throw new Error("Enter at least one hash.");
        return list;
      },
    });
  }
  return listCommits(repoDir, sel);
}

module.exports = { chooseCommits };
