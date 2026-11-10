"use strict";

const { option } = require("../lib/args");
const { parseRepoDir, readCommit, shortHash, subject } = require("./repo");
const { chooseCommits } = require("./select");
const { formatDate } = require("./timestamps");

async function run(flags) {
  const repoDir = await option(flags, "repo", "📂 Repo path", { parse: parseRepoDir });
  const hashes = await chooseCommits(flags, repoDir);
  console.log(`\n  ${hashes.length} commit(s), oldest first\n`);

  if (flags.ids) {
    for (const h of hashes) console.log(`  ${h}`);
    return;
  }
  hashes.forEach((h, i) => {
    const c = readCommit(repoDir, h);
    const when = formatDate(Number(c.author.when.split(" ")[0]) * 1000);
    const merge = c.parents.length > 1 ? " [merge]" : "";
    console.log(`  ${String(i + 1).padStart(4)}. ${shortHash(h)}  ${when}  ${c.author.name}${merge}`);
    console.log(`        ${subject(c.message)}`);
  });
}

module.exports = { run };
