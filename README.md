# Project File Exporter — Utility Tools

A collection of zero-dependency Node.js CLI tools for transferring project files and git history between machines.

---

## Tools

| Tool | File | Use Case |
| ---- | ---- | -------- |
| **Files Copy** | `files_copy.js` | Copy all project files (text + binary) into a single JSON file and recreate them elsewhere |
| **Git History** | `git-history.js` | Transfer git commits from one repo to another using patches |

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
