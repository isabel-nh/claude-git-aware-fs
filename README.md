# claude-git-aware-fs

Claude Code mod that keeps the git index in sync when Claude deletes or moves files.

A Bash `rm` or `mv` of a git-tracked path leaves the deletion or rename unstaged; git sees a deleted file and a new untracked one. This mod catches those commands before they run and routes tracked paths through `git rm` / `git mv`.

| Command | Behavior |
| --- | --- |
| `rm` / `mv` on untracked paths, or outside any git work tree | Runs unchanged. |
| `rm [-r] [-f] paths`, every path tracked in one repository | Runs as `git rm [-r] [-f] -- paths` (rewrite mode). `-r` is added when a path is a tracked directory. |
| `mv [-f] src... dst`, every source tracked in the destination's repository | Runs as `git mv [-f] -- src... dst` (rewrite mode). |
| Mixed tracked and untracked paths, several repositories, unsupported options, expansions, redirects | Denied, with the exact `git rm` / `git mv` command for the tracked paths and plain `rm` / `mv` for the rest. |
| A tracked file moved out of its repository | Denied, with the plain `mv` plus `git rm --cached` to record the removal. |
| A glob (`*`, `?`, `[`, `{a,b}`) inside a git work tree | Denied: list the paths explicitly. Outside a work tree it runs. |
| `Remove-Item` / `ri` / `del` / `Move-Item` / `mi` / `move` inside `powershell -Command` / `pwsh -c` | Denied with the `git rm` / `git mv` command when a path is tracked; never rewritten. |

Paths resolve against a leading `cd` (subshells included), else the session's directory. When the shell's directory is outside the paths' repository, the rewrite runs `git -C <top> ...` with paths from the repository top. Temp directories (`/tmp`, `$TEMP`, `$TMPDIR`, `AppData/Local/Temp`, macOS `/var/folders`) are never asked about. Every other path is checked with `git rev-parse` and `git ls-files`, batched per directory; a git call that fails (not a repository, git missing) counts as untracked.

`rm` without `-f` on a tracked file with local modifications is rewritten without `-f`, so git's own refusal stands.

If the guard fails, the call is denied, never passed through.

Works with Git Bash on Windows (MinGW `/c/...` paths), macOS and Linux.

## Option: `mode`

- `rewrite` (default): simple commands on tracked paths are rewritten and run; the model is told which command ran in place of which. Anything else touching tracked paths is denied with the commands to run.
- `deny`: every `rm` / `mv` touching tracked paths is denied with the commands to run.

Set it in `settings.json`:

```json
"pluginConfigs": {
  "git-aware-fs@isabel-nh": {
    "options": { "mode": "deny" }
  }
}
```

## Limits

- `git rm -r dir` removes tracked files only: untracked files inside a tracked directory stay on disk.
- `rm` / `mv` reached through `sudo`, `xargs`, `find -exec`, `bash -c`, a script file or a command substitution are not seen.
- A path after `cd "$VAR"`, or one holding a variable or `~`, cannot be resolved and is treated as untracked unless the same command also touches a resolvable tracked path.
- Path case is matched as git stores it: on a case-insensitive file system, `rm A.TXT` for a tracked `a.txt` runs unchanged.
- Read, Write and Edit do not delete or move files, and MCP tools are not covered.

## Install

The plugin is published through the [isabel-nh marketplace](https://github.com/isabel-nh/marketplace).

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add isabel-nh/marketplace
/plugin install git-aware-fs@isabel-nh
```

From a shell:

```bash
claude plugin marketplace add isabel-nh/marketplace
```

```bash
claude plugin install git-aware-fs@isabel-nh
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `isabel-nh/marketplace`, then Add plugin.

Pick a scope when prompted (user scope applies to every session).

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`tsc -p .` type-checks once Claude Code has loaded the mod and written `.claude-plugin/types/`.
