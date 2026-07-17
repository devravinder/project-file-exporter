# File Manager Utility

A Node.js CLI tool that exports an entire folder (including binary files) into a single portable JSON file — and recreates it anywhere.

Think of it as a simple file/folder exporter: pack a project into one `.json` file, copy-paste or transfer it, then unpack it back into a full folder structure.

## Why?

- Export a git bare repo, a project folder, or any directory into **one file**
- Copy-paste friendly — the JSON file can be shared via chat, email, or clipboard
- Supports **all file types** — text files stored as-is, binary files (PDFs, images, git objects) stored as base64
- Respects ignore patterns (like `.gitignore` style)

## Setup

```bash
cd project-file-exporter
npm install
```

## Usage

### Commands

```bash
node start.js <command> <config-file>
```

| Command | Short | Description |
|---------|-------|-------------|
| `init` | `i` | Create a config file (set target folder & ignore patterns) |
| `read` | `r` | Read all files from target folder into the config file |
| `create` | `c` | Recreate all files from config into the target folder |
| `info` | — | Show summary of a config file |
| `help` | `h` | Show help |

### Examples

```bash
# Create a config for a project
node start.js init my-project.json

# Export all files from the target folder into the JSON
node start.js read my-project.json

# Recreate the folder from the JSON (on another machine, another path, etc.)
node start.js create my-project.json

# View what's inside a config file
node start.js info my-project.json

# Interactive mode — prompts for everything
node start.js

# Interactive mode with a config file
node start.js my-project.json
```

## Workflow

### Export a folder

```
node start.js init project.json
  → Enter target: C:\my-projects\webapp
  → Enter ignore: **/node_modules, **/dist, .git

node start.js read project.json
  → Reads all files from C:\my-projects\webapp
  → Saves everything into project.json
```

Now `project.json` contains your entire folder. Copy it anywhere.

### Import / Recreate

```
node start.js create project.json
  → Recreates all files into the target folder
```

Or edit the `target` path in the JSON first to write to a different location.

## Config File Format

```json
{
  "target": "C:/path/to/your/project",
  "ignore": [
    "**/node_modules",
    "**/dist",
    ".git"
  ],
  "files": [
    {
      "path": "src/index.js",
      "encoding": "text",
      "content": "const app = require('express')();\n..."
    },
    {
      "path": "assets/logo.png",
      "encoding": "base64",
      "content": "iVBORw0KGgoAAAANSUhEUg..."
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `target` | The folder to read from / write to |
| `ignore` | Glob patterns to skip (supports `**`, `*`, `?`) |
| `files` | Array of all file entries |
| `files[].path` | Relative path (always linux format `/`) |
| `files[].encoding` | `text` or `base64` |
| `files[].content` | File content (raw text or base64 encoded) |

## Ignore Patterns

Works like `.gitignore` style patterns:

| Pattern | Matches |
|---------|---------|
| `**/node_modules` | `node_modules` anywhere in the tree |
| `**/dist` | Any `dist` folder at any depth |
| `.git` | `.git` folder/file in any segment |
| `client/node_modules` | Only `client/node_modules` (exact path) |
| `*.log` | Any `.log` file in any segment |

## Notes

- All paths are stored in **linux format** (forward slashes) regardless of OS
- You can pass Windows (`C:\foo\bar`) or Linux (`C:/foo/bar`) paths — both work
- Text files have zero overhead in storage
- Binary files use base64 encoding (+33% size) to remain copy-paste safe
- Binary vs text detection is automatic (utf-8 round-trip integrity check)
- The config JSON file is fully portable — open it, copy it, paste it anywhere
