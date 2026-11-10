# File Transfer

Move a **git repository's history** or a **plain folder** between machines as
size-limited JSON part files that you can copy and paste by hand.
Zero dependencies - Node.js and git (git only for the git tools). Developed and tested on Node 26 / git 2.55 on Windows.

```bash
node file-transfer.js
```

```text
1) Git repository (commit history)     1) Export   2) Restore   3) List commits   4) Change timestamps
2) Files (non-git folder)              1) Pack     2) Unpack
```

Everything can also be run directly with flags; anything not given is asked.

## Typical flow

**Source machine** - `Git → Export`: pick the repo, which commits, the size limit (default 350 KB)
and an output folder. You get `1.json`, `2.json`, `3_1.json`, `3_2.json`, `4.json`, ... (default folder `out`; a commit/file too big
for one part is split into `N_1`, `N_2`, ...; numbers are zero-padded once there are more than 9 / 99 files).

**Destination machine** - copy the part files over (open each, select all, copy, paste into a new file -
the file *names* do not matter), then `Git → Restore`: pick the folder with the parts and the
destination repo. It is created (and `git init`-ed) if it does not exist.

```bash
node file-transfer.js git export  --repo C:/src/app --mode all --limit 350 --out parts
node file-transfer.js git restore --parts parts --dest D:/new/app
```

Plain folders work the same way:

```bash
node file-transfer.js files pack   --src C:/docs --ignore ".git,node_modules" --limit 350 --out parts
node file-transfer.js files unpack --parts parts --dest D:/docs
```

## Commands

| Command | What it does | Flags |
| ------- | ------------ | ----- |
| `git export` | Commits → part files | `--repo --mode all\|last\|unpushed\|hashes [--count N] [--hashes a,b] --limit 350 --out` |
| `git restore` | Part files → repo (original authors, messages, timestamps) | `--parts --dest [--yes]` |
| `git list` | List commits (oldest first) | `--repo --mode ... [--ids]` |
| `git retime` | Re-date commits of an existing repo | `--repo [--last N] --start --end [--seed N] [--yes]` |
| `files pack` | Folder → part files | `--src [--ignore a,b] --limit 350 --out` |
| `files unpack` | Part files → folder | `--parts --dest [--overwrite]` |

Sizes: a bare number is KB (`350`, `350kb`, `1.5mb`).

## Size limit and splitting

The limit applies to each finished part file (header + JSON + base64 included).
Small commits/files are packed together. A commit or file that is too big on its own is
**split automatically across several parts** and joined again on restore - no manual splitting.

## Part files

JSON with a small readable header and gzip + base64 data:

```json
{ "format": "gt1", "kind": "git", "exportId": "218752119447", "seq": 3, "total": 7,
  "sha256": "...", "encoding": "gzip+base64", "data": ["H4sIAAAA...", "..."] }
```

- The file name is irrelevant; `exportId`, `seq` and `total` are inside the file.
- Restore checks every part's checksum and tells you exactly which part is **missing**,
  **cut off** or **changed** while copying - nothing is applied until all parts are valid.
- BOM, CRLF line endings and extra whitespace from editors/pasting are tolerated.
- If a folder holds parts from more than one export you are asked which one to use.

## Git restore

- Applies each commit with `git apply --3way` + `git commit`, keeping the original author, committer,
  message and **both timestamps**. Binary files, renames, CRLF and empty commits are handled.
- Merge commits are skipped (and reported); history is restored as a straight line.
- At the end the final tree hash is compared with the source: *identical* / *differs*.
- **Existing repo**: must be clean; a backup ref `refs/gt/backup-<time>` is created first
  (undo with `git reset --hard <ref>`).
- **Conflict**: it stops, leaves the repo clean and saves progress in `.git/gt-restore-state.json`.
  Run Restore again to **retry** or **skip** that commit and continue.

## Change timestamps (`git retime`)

Re-dates commits of an existing repo: strictly increasing, first commit = start, last commit = end,
every gap random between **5 minutes and 1 day**. The plan is calculated first and shown for confirmation.

- Format `YYYY-MM-DD hh:mm:ss`; the time may be partial (`2026-11-10` = `00:00:00`, `2026-11-10 11:30` = `11:30:00`).
  Local time zone.
- If the range cannot hold the commits (needs `(N-1) × 5 min ≤ end − start ≤ (N-1) × 1 day`) it aborts and
  prints the valid end range for your start.
- `--seed N` reproduces the same plan. `--last N` re-dates only the newest N commits.
- Rewrites history (new hashes) - do not use on commits already pushed and shared.
  A backup ref is created; other branches/tags are not moved. Linear history only.

## Layout

```text
file-transfer.js       entry point (menu + direct commands)
lib/                   prompt, args, size, paths, proc (git runner), packer, assemble
git/                   export, restore, retime, list, select, repo, timestamps
files/                 pack, unpack, ignore
```

## Not included

- Empty folders are not carried by `files pack` (only files).
- Branches, tags and merge commits are not transferred - only a linear commit sequence.
- Whole export is built in memory; fine for normal repos/folders, not for multi-GB data.
