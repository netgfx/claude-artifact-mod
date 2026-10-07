# claude-artifact-mod

A Claude Code plugin for handling locally produced artifacts and files.

**artifact-mod** adds a side pane that lists every file produced during a session (images, PDFs, documents, code, anything), each with an icon for its file type. Opening an item launches it in your system's default app.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install artifact-mod --marketplace netgfx/claude-artifact-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope is the default).

## Features

- **Automatic tracking.** After any tool that can change files (Write, Edit, Bash, PowerShell, MCP tools), files modified during that call are added: paths named in the tool's input, path-like tokens in shell commands (`> out.txt`, `-o report.pdf`), and new files at the top level of the working directory. Read-only tools are ignored, as are `.git` and `node_modules`.
- **Paths only.** The mod stores each artifact's local path and nothing else. The list lasts for the session and survives resume.
- **Stays in sync with disk.** Files deleted from disk disappear from the pane within a few seconds.
- **Icons by type.** 🎨 images, 📕 PDF, 📝 text/markdown, 💻 code, 📊 spreadsheets, 🔧 config, 🌐 HTML, 📦 archives, 🎵 audio, 🎬 video, 📄 everything else.
- **Pagination.** Page size fits the pane's height. ◀ Prev / Next ▶ (`p` / `n`).
- **Open with the default app.** `explorer.exe` on Windows, `open` on macOS, `xdg-open` on Linux.

## Usage

| Action | Result |
| --- | --- |
| `/artifacts` | Open the pane and give it the keyboard |
| Tab | Select an item |
| Enter, or `o` | Open the selected item |
| Double-click | Open an item |
| `n` / `p` | Next / previous page |

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
