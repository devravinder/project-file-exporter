#!/usr/bin/env node
"use strict";

const prompt = require("./lib/prompt");
const { parseArgs } = require("./lib/args");

// ╔══════════════════════════════════════════════════════════╗
// ║  File Transfer — git history + plain files               ║
// ║                                                          ║
// ║    node file-transfer.js              (menu)             ║
// ║    node file-transfer.js git export   [--flags]          ║
// ║    node file-transfer.js git restore  [--flags]          ║
// ║    node file-transfer.js git list     [--flags]          ║
// ║    node file-transfer.js git retime   [--flags]          ║
// ║    node file-transfer.js files pack   [--flags]          ║
// ║    node file-transfer.js files unpack [--flags]          ║
// ║    node file-transfer.js help                            ║
// ╚══════════════════════════════════════════════════════════╝

const COMMANDS = {
  git: {
    export: () => require("./git/export"),
    restore: () => require("./git/restore"),
    list: () => require("./git/list"),
    retime: () => require("./git/retime"),
  },
  files: {
    pack: () => require("./files/pack"),
    unpack: () => require("./files/unpack"),
  },
};

const HELP = `
  File Transfer - move git history or plain files between machines as
  size-limited, copy-and-paste friendly JSON part files.

  Usage
    node file-transfer.js                       interactive menu
    node file-transfer.js <group> <command> [--flags]

  git export     --repo <path> --mode all|last|unpushed|hashes [--count N] [--hashes a,b]
                 --limit 350 --out <folder>
  git restore    --parts <folder> --dest <repo> [--yes]
  git list       --repo <path> --mode ... [--ids]
  git retime     --repo <path> [--last N] --start "2026-11-01" --end "2026-11-10 18:00"
                 [--seed 123] [--yes]

  files pack     --src <folder> [--ignore ".git,node_modules"] --limit 350 --out <folder>
  files unpack   --parts <folder> --dest <folder> [--overwrite]

  Any value not given as a flag is asked interactively.
  Sizes: a bare number is KB (350, 350kb, 1.5mb).
  Dates: YYYY-MM-DD hh:mm:ss - the time part is optional (missing parts = 0).
`;

async function runCommand(group, command, flags) {
  const loader = COMMANDS[group] && COMMANDS[group][command];
  if (!loader) {
    console.log(HELP);
    throw new Error(`Unknown command: ${group || ""} ${command || ""}`.trim());
  }
  await loader().run(flags);
}

async function interactive() {
  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║           File Transfer              ║");
  console.log("  ╚══════════════════════════════════════╝");
  for (;;) {
    const group = await prompt.menu("What do you want to transfer?", [
      { label: "Git repository (commit history)", value: "git" },
      { label: "Files (non-git folder)", value: "files" },
    ]);
    if (!group) return;
    const items =
      group === "git"
        ? [
            { label: "Export    - repo → part files", value: "export" },
            { label: "Restore   - part files → repo", value: "restore" },
            { label: "List commits", value: "list" },
            { label: "Change timestamps of an existing repo", value: "retime" },
          ]
        : [
            { label: "Pack      - folder → part files", value: "pack" },
            { label: "Unpack    - part files → folder", value: "unpack" },
          ];
    const command = await prompt.menu(group === "git" ? "Git" : "Files", items, "b) Back");
    if (!command) continue;
    await runCommand(group, command, {});
    return;
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || positional[0] === "help" || positional[0] === "h") {
    console.log(HELP);
    return;
  }
  if (positional.length === 0) {
    await interactive();
  } else {
    await runCommand(positional[0], positional[1], flags);
  }
}

main()
  .catch((err) => {
    console.error(`\n  ❌ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prompt.close());
