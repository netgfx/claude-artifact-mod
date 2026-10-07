import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact } from '../types'

const PANE = 'artifact-mod'
const TITLE = 'Artifacts'
const ITEM = 'a:'
const COMMAND = 'local-artifacts'

const artifacts = atom({ plugin: 'artifact-mod', key: 'artifacts' } as const, [])
const page = atom({ plugin: 'artifact-mod', key: 'page' } as const, 0)
const selected = atom({ plugin: 'artifact-mod', key: 'selected' } as const, '')

/** A press on an already-selected row, or a second press inside this window, opens it. */
const DOUBLE_MS = 500
/** A focus move this close before a press came from the same click. */
const CLICK_FOCUS_MS = 200
/** Filesystem mtimes can trail the wall clock a little. */
const MTIME_SLACK_MS = 2000
const PRUNE_EVERY_MS = 4000

let lastPress = { path: '', at: 0 }
let lastFocus = { path: '', at: 0 }
let platform: 'win' | 'mac' | 'linux' | undefined

// ---------- file types ----------

/** The only kinds listed: media and documents. Code, config, archives and binaries are not artifacts. */
const ICONS: [string, readonly string[]][] = [
  ['🎨', ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif']],
  ['📕', ['pdf']],
  ['📘', ['doc', 'docx', 'odt', 'rtf']],
  ['📙', ['ppt', 'pptx', 'odp', 'key']],
  ['📊', ['csv', 'tsv', 'xls', 'xlsx', 'ods']],
  ['📝', ['md', 'markdown', 'txt', 'rst']],
  ['🌐', ['html', 'htm']],
  ['🎵', ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']],
  ['🎬', ['mp4', 'mov', 'mkv', 'webm', 'avi']],
]

function extOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function iconOf(path: string): string {
  const ext = extOf(path)
  return ICONS.find(([, exts]) => exts.includes(ext))?.[0] ?? '📄'
}

function isShown(path: string): boolean {
  const ext = extOf(path)
  return ICONS.some(([, exts]) => exts.includes(ext))
}

// ---------- paths ----------

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : ''
}

function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith('\\\\')
}

/** One spelling per file: Windows paths get backslashes, single separators. */
function nativePath(path: string): string {
  if (!isWindowsPath(path)) return path.replace(/\/{2,}/g, '/')
  const unc = path.startsWith('\\\\') || path.startsWith('//')
  const body = path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')

  return unc ? `\\${body}` : body
}

/** Windows paths compare without case and without slash direction. */
function fileKey(path: string): string {
  const native = nativePath(path)

  return isWindowsPath(native) ? native.toLowerCase() : native
}

function sameFile(a: string, b: string): boolean {
  return fileKey(a) === fileKey(b)
}

function unique(list: Artifact[]): Artifact[] {
  const seen = new Set<string>()

  return list.filter(a => !seen.has(fileKey(a.path)) && seen.add(fileKey(a.path)))
}

/** Tool plumbing, not work: VCS and dependency folders, and Claude Code's background-task logs. */
const IGNORED = /[\\/](\.git|node_modules|__pycache__|\.venv)[\\/]|\.output$/i

const PATH_KEY = /path|file|output|dest|target|save/i
/** Fields that name a file the tool writes, even when the tool calls itself read-only (screenshots). */
const OUTPUT_KEY = /filename|output|dest|save/i

/**
 * Strings that may name a file: path-like input fields, and tokens of a shell command.
 * For a read-only tool, only fields that name an output count.
 */
function candidatesOf(tool: string, input: Record<string, unknown>, outputsOnly = false): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(input)) {
    const values = Array.isArray(v) ? v : [v]
    for (const one of values) {
      if (typeof one !== 'string') continue
      if (k === 'command' && (tool === 'Bash' || tool === 'PowerShell')) {
        if (!outputsOnly) out.push(...shellTokens(one))
      } else if ((outputsOnly ? OUTPUT_KEY : PATH_KEY).test(k) && one.length < 1024) out.push(one)
    }
  }

  return out
}

function shellTokens(command: string): string[] {
  const out: string[] = []
  const TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'<>|;&()]+)/g
  for (const m of command.matchAll(TOKEN)) {
    let token = m[1] ?? m[2] ?? m[3] ?? ''
    if (token.includes('=')) token = token.slice(token.lastIndexOf('=') + 1)
    // `$PWD/out.png` is relative to the working directory; any other variable or substitution cannot be resolved.
    token = token.replace(/^(\$PWD|\$\{PWD\})(?=[\\/])/, '.')
    if (token === '' || token.includes('://') || token.startsWith('-') || /[$`~]/.test(token)) continue
    if (/[\\/]/.test(token) || /\.[A-Za-z0-9]{1,8}$/.test(token)) out.push(token)
    if (out.length >= 40) break
  }

  return out
}

// ---------- tracking ----------

function absOf(cwd: string, path: string): string {
  return nativePath(isAbsolute(path) ? path : `${cwd}/${path.replace(/^\.[\\/]/, '')}`)
}

const MAX_SCAN_DIRS = 8

/**
 * Where a tool may have written files without naming them: the working directory,
 * and the folders of the paths it did name (a converter writing panel.png beside panel.svg).
 */
function scanDirs(cwd: string, raw: string[]): string[] {
  const dirs: string[] = []
  for (const dir of [nativePath(cwd), ...raw.map(p => dirName(absOf(cwd, p)))]) {
    if (dir === '' || IGNORED.test(`${dir}\\`) || dirs.some(d => sameFile(d, dir))) continue
    dirs.push(dir)
    if (dirs.length >= MAX_SCAN_DIRS) break
  }

  return dirs
}

async function dirFiles($: EngineInterface, dir: string): Promise<{ path: string; mtimeMs: number }[]> {
  try {
    return (await $.fs.list(dir))
      .filter(entry => entry.kind === 'file' && isShown(entry.name))
      .map(entry => ({ path: absOf(dir, entry.name), mtimeMs: entry.mtimeMs }))
  } catch {
    // A missing or unreadable folder adds nothing.
    return []
  }
}

/** Files that exist before a tool runs: one the tool then writes was modified, not made. */
async function existing($: EngineInterface, raw: string[]): Promise<Set<string>> {
  const cwd = await $.session.cwd()
  const keys = new Set<string>()
  for (const path of raw) {
    const abs = absOf(cwd, path)
    try {
      if (await $.fs.exists(abs)) keys.add(fileKey(abs))
    } catch {
      // Unknown: treated as new.
    }
  }
  for (const dir of scanDirs(cwd, raw)) {
    for (const f of await dirFiles($, dir)) keys.add(fileKey(f.path))
  }

  return keys
}

async function track($: EngineInterface, raw: string[], since: number, scanCwd: boolean, existed: Set<string>) {
  const cwd = await $.session.cwd()
  const listed = await read($, artifacts)
  const seen = new Set<string>()
  const found: string[] = []
  const consider = async (path: string) => {
    const abs = absOf(cwd, path)
    if (seen.has(fileKey(abs))) return
    seen.add(fileKey(abs))
    try {
      const st = await $.fs.stat(abs, { resolve: true })
      if (st.kind !== 'file' || st.mtimeMs < since - MTIME_SLACK_MS) return
      const real = nativePath(st.realPath ?? abs)
      if (IGNORED.test(real) || !isShown(real) || found.some(p => sameFile(p, real))) return
      // Only files this session made; rewriting one it made keeps it listed.
      const isNew = !existed.has(fileKey(abs)) && !existed.has(fileKey(real))
      if (isNew || listed.some(a => sameFile(a.path, real))) found.push(real)
    } catch {
      // Not a file on disk: not an artifact.
    }
  }

  for (const path of raw) await consider(path)

  // Files a command wrote without naming them, in the folders it touched.
  if (scanCwd) {
    for (const dir of scanDirs(cwd, raw)) {
      for (const f of await dirFiles($, dir)) {
        if (f.mtimeMs >= since - MTIME_SLACK_MS) await consider(f.path)
      }
    }
  }

  if (found.length === 0) return
  const before = (await read($, artifacts)).length
  const now = Date.now()
  await update($, artifacts, list => {
    const rest = list.filter(a => !found.some(p => sameFile(p, a.path)))
    const fresh = found.map(path => list.find(a => sameFile(a.path, path)) ?? { path, addedAt: now })

    return unique([...fresh, ...rest])
  })
  await update($, page, () => 0)
  await persist($)
  if (before === 0) void $.ui.open({ id: PANE, title: TITLE })
}

async function storeKey($: EngineInterface): Promise<string> {
  return `session:${await $.session.id()}`
}

async function persist($: EngineInterface) {
  await $.store.set(await storeKey($), await read($, artifacts))
}

/** Drops every artifact whose file is gone from disk, is not a listed kind, or is listed twice. */
async function prune($: EngineInterface) {
  const list = await read($, artifacts)
  const gone: string[] = []
  for (const a of list) {
    if (IGNORED.test(a.path) || !isShown(a.path) || !(await $.fs.exists(a.path))) gone.push(a.path)
  }
  const isDuplicated = unique(list).length !== list.length
  if (gone.length === 0 && !isDuplicated) return
  await update($, artifacts, l => unique(l.filter(a => !gone.includes(a.path))))
  if (gone.includes(await read($, selected))) await update($, selected, () => '')
  await persist($)
}

// ---------- opening ----------

async function detectPlatform($: EngineInterface): Promise<'win' | 'mac' | 'linux'> {
  if (platform) return platform
  if ((await $.env.get('OS')) === 'Windows_NT') return (platform = 'win')
  try {
    const { stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
    platform = stdout.trim() === 'Darwin' ? 'mac' : 'linux'
  } catch {
    platform = 'linux'
  }

  return platform
}

async function openArtifact($: EngineInterface, path: string) {
  if (!(await $.fs.exists(path))) {
    $.ui.toast(`${baseName(path)} no longer exists`)
    await prune($)
    return
  }
  const os = await detectPlatform($)
  const argv =
    os === 'win'
      ? ['explorer.exe', path.replace(/\//g, '\\')]
      : os === 'mac'
        ? ['open', path]
        : ['xdg-open', path]
  try {
    // explorer.exe exits 1 even when it opened the file, so the code is not checked.
    await $.process.run(argv, { timeoutMs: 15000 })
    $.ui.toast(`Opened ${baseName(path)}`)
  } catch (err) {
    $.ui.toast(`Could not open ${baseName(path)}: ${String(err)}`)
  }
}

async function pressItem($: EngineInterface, path: string) {
  const now = Date.now()
  const isDouble = lastPress.path === path && now - lastPress.at < DOUBLE_MS
  const focusedByThisClick = lastFocus.path === path && now - lastFocus.at < CLICK_FOCUS_MS
  const wasSelected = (await read($, selected)) === path
  lastPress = { path, at: now }

  if (isDouble || (wasSelected && !focusedByThisClick)) {
    lastPress = { path: '', at: 0 }
    await openArtifact($, path)
    return
  }
  await update($, selected, () => path)
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Claude Code has its own built-in /artifacts, so the mod's command needs a name of its own.
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Show the media files and documents created in this session',
      })
    } catch {
      // Without the command the pane still opens and tracks; only the shortcut is lost.
    }

    if ((await read($, artifacts)).length === 0) {
      const saved = await $.store.get(await storeKey($))
      if (Array.isArray(saved) && saved.length > 0) {
        // Lists saved before paths were normalized can hold one file twice.
        await update($, artifacts, () =>
          unique(
            (saved as Artifact[]).map(a => ({ ...a, path: nativePath(a.path) })).filter(a => !IGNORED.test(a.path) && isShown(a.path)),
          ),
        )
      }
    }
    await prune($)
    $.clock.every(PRUNE_EVERY_MS, () => void prune($))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await prune($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Artifacts pane opened. Tab selects, Enter or double-click opens.' }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const named = candidatesOf(String(e.tool), input).filter(isShown)
    let existed = new Set<string>()
    try {
      existed = await existing($, named)
    } catch {
      // Without a snapshot every file counts as new.
    }
    const since = Date.now()
    const ran = await next(e)
    if (ran.deny === undefined) {
      // Read-only tools can still save a file they were told to (a browser screenshot's `filename`).
      const readOnly = ran.isReadOnly === true
      const raw = readOnly ? candidatesOf(String(e.tool), input, true).filter(isShown) : named
      try {
        if (!readOnly || raw.length > 0) await track($, raw, since, !readOnly, existed)
      } catch {
        // Tracking never fails the tool call.
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.focus', async ($, e, next) => {
    const moved = await next(e)
    const element = e.element
    if (
      e.requestId === PANE &&
      element !== undefined &&
      element.startsWith(ITEM) &&
      !('deny' in moved && moved.deny !== undefined)
    ) {
      const path = element.slice(ITEM.length)
      lastFocus = { path, at: Date.now() }
      await update($, selected, () => path)
    }

    return moved
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, artifacts)
    const sel = await read($, selected)
    const cols = Math.max(20, e.props.bodyColumns)
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const perPage = Math.max(3, rows - 4)
    const pages = Math.max(1, Math.ceil(list.length / perPage))
    const current = Math.min(Math.max(0, await read($, page)), pages - 1)
    const shown = list.slice(current * perPage, (current + 1) * perPage)
    const nameRoom = Math.max(8, cols - 6)

    const goto = (to: number) => update($, page, () => Math.min(Math.max(0, to), pages - 1))

    return (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            {list.length} artifact{list.length === 1 ? '' : 's'}
          </Text>
          {pages > 1 && <Text dimColor>{`page ${current + 1}/${pages}`}</Text>}
        </Box>

        {list.length === 0 && (
          <Text dimColor wrap="wrap">
            No artifacts yet. Files written or generated in this session show up here.
          </Text>
        )}

        {shown.map((a, i) => {
          const isSel = sameFile(a.path, sel)
          const name = baseName(a.path)
          const label = name.length > nameRoom ? `${name.slice(0, nameRoom - 1)}…` : name
          const dir = dirName(a.path)

          return (
            <Box key={`row:${a.path}`} flexDirection="row" gap={1}>
              <Text color="cyan">{isSel ? '▸' : ' '}</Text>
              <Button
                plain
                key={`${ITEM}${a.path}`}
                label={`${iconOf(a.path)} ${label}`}
                autoFocus={i === 0 && current === 0 && sel === '' ? true : undefined}
                onPress={() => void pressItem($, a.path)}
              />
              {cols - label.length > 16 && dir !== '' && (
                <Text dimColor wrap="truncate-start">
                  {dir}
                </Text>
              )}
            </Box>
          )
        })}

        {list.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              {pages > 1 && (
                <Button key="prev" hotkey="p" onPress={() => void goto(current - 1)}>
                  ◀ Prev
                </Button>
              )}
              {pages > 1 && (
                <Button key="next" hotkey="n" onPress={() => void goto(current + 1)}>
                  Next ▶
                </Button>
              )}
              {sel !== '' && (
                <Button key="open" hotkey="o" variant="primary" onPress={() => void openArtifact($, sel)}>
                  Open
                </Button>
              )}
            </Box>
            <Text dimColor wrap="truncate-end">
              Tab select · Enter / double-click open{pages > 1 ? ' · n/p page' : ''}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
