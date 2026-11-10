"use strict";

const readline = require("readline");

// One shared readline for the whole run. Lines are queued, so it also works
// with piped stdin (scripts / tests), not only in a terminal.

let rl = null;
let closed = false;
const queue = [];
const waiters = [];

function init() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    queue.push(line);
    flush();
  });
  rl.on("close", () => {
    closed = true;
    flush();
  });
  rl.on("SIGINT", () => {
    console.log("\n  Cancelled.");
    process.exit(130);
  });
}

function flush() {
  while (waiters.length && waiters[0]()) waiters.shift();
}

function ask(question) {
  init();
  return new Promise((resolve, reject) => {
    rl.setPrompt(question);
    rl.prompt();
    const take = () => {
      if (queue.length) {
        const answer = queue.shift().trim();
        if (!process.stdin.isTTY) process.stdout.write(answer + "\n");
        resolve(answer);
        return true;
      }
      if (closed) {
        reject(new Error("Input closed before an answer was given."));
        return true;
      }
      return false;
    };
    if (!take()) waiters.push(take);
  });
}

// y/n question. `def` is the answer for an empty reply.
async function confirm(question, def = true) {
  for (;;) {
    const a = (await ask(`${question} (${def ? "Y/n" : "y/N"}): `)).toLowerCase();
    if (a === "") return def;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}

// Numbered menu. Returns the chosen item's value, or null for q / b.
async function menu(title, items, quitLabel = "q) Quit") {
  for (;;) {
    console.log(`\n  ${title}`);
    items.forEach((it, i) => console.log(`    ${i + 1}) ${it.label}`));
    console.log(`    ${quitLabel}`);
    const a = (await ask("\n  Select: ")).toLowerCase();
    if (a === "q" || a === "b") return null;
    const n = parseInt(a, 10);
    if (n >= 1 && n <= items.length) return items[n - 1].value;
    console.log("  ⚠ Invalid option.");
  }
}

function close() {
  if (rl) rl.close();
}

module.exports = { ask, confirm, menu, close };
