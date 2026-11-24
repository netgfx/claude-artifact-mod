# Privacy

Local Artifacts (`powermods-artifacts`) is a Claude Code mod that runs on your own machine. This statement covers what it collects, keeps and sends.

## What it collects

Nothing about you. The mod has no accounts, analytics or telemetry, and it collects no personal data.

## What it keeps on your machine

- **The paths of the files each session made**, with the time each file was first seen and the time the list was last saved. They are kept in the plugin's own store in Claude Code (`$.store`), under the session's id, so a resumed session shows its list again. The store is on your machine and is shared by every Claude Code session that runs the mod.
- File contents are never read or stored.

## What leaves your machine

Nothing. The mod makes no network requests (`network.hosts` in `plugin.json` is empty), sends nothing to a model and has no server of its own. Opening an item hands the file to your system's default app, which runs as it normally would.

## Retention

A session's list is deleted automatically 30 days after that session last opened or changed it. Files that no longer exist on disk are dropped from the list within a few seconds.

## How to delete your data

The lists live in Claude Code's plugin store, a file under `~/.claude/plugins/store/` whose name starts with `powermods-artifacts_`. Delete that file, while no Claude Code session is running, to remove every saved list. Lists older than 30 days are deleted on their own the next time a session starts.

## Sharing

No data is sold or shared with anyone.

## Children

The mod is a developer tool and is not directed at people under 18.

## Contact

Questions or requests: open an issue at <https://github.com/netgfx/claude-artifact-mod/issues>.
