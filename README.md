# Project File Exporter — Utility Tools

A collection of zero-dependency Node.js CLI tools for transferring project files and git history between machines.

---

## Tools

| Tool | File | Use Case |
| ---- | ---- | -------- |
| **Files Copy** | `files_copy.js` | Copy all project files (text + binary) into a single JSON file and recreate them elsewhere |
| **Git History** | `git-history.js` | Transfer git commits from one repo to another using patches |
| **Git Utility** | `git-utility.js` | Interactive tool to list commits and group commits by change size |
| **Splitter** | `splitter.js` | Split a text file into size-limited parts (in KB), or combine files back together |

---

## How to Use

### Files Copy

```bash
node files_copy.js <command> <config-file>
```

| Command | Description |
| ------- | ----------- |
| `init` | Create a config (set target folder + ignore patterns) |
| `read` | Read all files from target folder into config JSON |
| `create` | Recreate files from config JSON into target folder |
| `info` | Show summary |

```bash
node files_copy.js init project.json
node files_copy.js read project.json
# copy project.json to another machine, change target path
node files_copy.js create project.json
```

### Git History

```bash
node git-history.js <command> <config-file>
```

| Command | Description |
| ------- | ----------- |
| `init` | Create a config (set repo path + commit selection) |
| `read` | Export commits from repo into config JSON as patches |
| `write` | Apply stored patches to repo |
| `info` | Show summary |

```bash
node git-history.js init transfer.json
node git-history.js read transfer.json
# copy transfer.json to another machine, change repo path
node git-history.js write transfer.json
```

---

## How It Works

### Files Copy Working

1. **read** — Scans the target folder, reads all files (text as UTF-8, binary as base64), stores them in a single JSON config file.
2. **create** — Reads file entries from the JSON config and recreates the folder structure + files at the target path.

```text
┌─────────────┐   read    ┌─────────────┐   create   ┌─────────────┐
│  Folder A   │  ───────► │ config.json │  ────────►  │  Folder B   │
└─────────────┘           └─────────────┘             └─────────────┘
```

One JSON file carries everything — file paths, content, and encoding info.

### Git History Working

1. **read** — Runs `git format-patch` for each commit, stores patch content inside the config JSON.
2. **write** — Extracts patches from config and applies them to the repo using `git am`.

```text
┌──────────┐   read    ┌─────────────┐   write   ┌──────────┐
│  Repo A  │  ───────► │ config.json │  ────────► │  Repo B  │
└──────────┘           └─────────────┘            └──────────┘
```

One JSON file carries config + all patch data. Preserves commit messages, authors, and dates.

---

## Examples

### Files Copy — Transfer a project to another machine

```bash
# On Machine A: create config and read project into JSON
node files_copy.js init project.json
# Edit project.json if needed → adjust "target" path, add ignore patterns
node files_copy.js read project.json

# Copy project.json to Machine B, then:
# Edit project.json → change "target" to destination path on this machine
node files_copy.js create project.json
```

### Git History — Transfer last 10 commits

```bash
# On Machine A: create config and export commits
node git-history.js init transfer.json
# Edit transfer.json if needed → adjust "repo" path, set lastNCommits or commits
node git-history.js read transfer.json

# Copy transfer.json to Machine B, then:
# Edit transfer.json → change "repo" to target repo path on this machine
node git-history.js write transfer.json
```

### Git History — Transfer specific commits

Create `transfer.json` manually:

```json
{
  "repo": "C:/projects/my-app",
  "commits": ["a1b2c3d", "d4e5f6a", "b7c8d9e"],
  "options": { "threeway": true, "keepAuthor": true }
}
```

```bash
node git-history.js read transfer.json
# Change "repo" to target repo path
node git-history.js write transfer.json
```

---

## Requirements

- **Node.js** — v12+
- **Git** — required only for git-history.js

---

## Git Utility

Interactive, menu-driven tool. No config file, no `init` — just run it. Works on Windows/Linux/Mac.

```bash
node git-utility.js
```

1. Enter a git repo path (Windows `C:\...` or Linux `/...`). Validated as an existing git repo; re-prompts until valid (`q` to quit).
2. Pick a menu option (menu loops until you quit):

| Option | Description |
| ------ | ----------- |
| `1` | All commits — **detailed** (short hash, subject, author, time), reverse order (oldest first) |
| `2` | All commits — **minimal** (full commit ids only), reverse order |
| `3` | Not-pushed commits — **detailed** (`git log --branches --not --remotes`) |
| `4` | Not-pushed commits — **minimal** (ids only) |
| `5` | Group commits by size |
| `q` | Quit |

### Group by size

Asks for:

- **Commit source** — all / last N / specific hashes / unpushed
- **Size limit** — in KB (a bare number like `300` means 300 KB; `300kb`, `1.5mb` also accepted)

Commits are packed in order into groups so each group stays within the limit. A single commit whose change is larger than the limit becomes its own group (flagged `⚠`), since one commit cannot be split.

Each commit's size = diff/patch bytes + binary blob sizes. All sizes shown in KB.

Example output for `limit = 300kb`, commits `[1a, 2b, 3c, 4d]` sized `250 / 50 / 220 / 100` KB:

```json
{
  "limit": "300.0 KB",
  "limitBytes": 307200,
  "commits": ["1a", "2b", "3c", "4d"],
  "groups": [
    ["1a"],
    ["2b", "3c"],
    ["4d"]
  ]
}
```

Optionally saves the result JSON to a file.

---

## Splitter

Interactive tool to split a text file into size-limited parts, or combine parts back together. Works on Windows/Linux/Mac.

```bash
node splitter.js
```

On launch, pick a mode:

| Option | Description |
| ------ | ----------- |
| `1` | **Split** — split a file into size-limited parts |
| `2` | **Combine** — join multiple files into one |
| `q` | Quit |

### Split

1. Enter a file path (Windows `C:\...` or Linux `/...`). Validated as an existing file.
2. Enter a max size per part in KB (a bare number like `300` means 300 KB; `300kb`, `1.5mb` also accepted).

The file is read as UTF-8 text and split into parts of at most the given size, written next to the source as `name-1.ext`, `name-2.ext`, ...

- Splits on character boundaries, so multi-byte (UTF-8) characters are never cut in half.
- Concatenating the parts reproduces the original file exactly.
- If the file is already within the limit, nothing is split.

Example — `1.json` is 1000 KB, size limit `300`:

```text
1-1.json  300 KB
1-2.json  300 KB
1-3.json  300 KB
1-4.json  100 KB
```

### Combine

1. Enter the files to combine, comma-separated, **in order** (e.g. `1-1.json, 1-2.json, 1-3.json, 1-4.json`).
2. Enter the output file path.

Each file is read as UTF-8 text and concatenated in the given order into the output file. Combining the parts produced by Split reproduces the original file exactly.

```bash
# combine the parts back into one file
node splitter.js
# → 2 (Combine)
# → 1-1.json, 1-2.json, 1-3.json, 1-4.json
# → 1.json
```
