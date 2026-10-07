import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact } from '../types'

const PANE = 'artifact-mod'
const TITLE = 'Artifacts'
const ITEM = 'a:'

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

const ICONS: [string, readonly string[]][] = [
  ['🎨', ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif']],
  ['📕', ['pdf']],
  ['📘', ['doc', 'docx', 'odt', 'rtf']],
  ['📙', ['ppt', 'pptx', 'odp', 'key']],
  ['📊', ['csv', 'tsv', 'xls', 'xlsx', 'ods', 'parquet']],
  ['📝', ['md', 'markdown', 'txt', 'log', 'rst']],
  ['🌐', ['html', 'htm', 'css']],
  ['🔧', ['json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'env', 'cfg', 'conf']],
  ['💻', ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'ps1', 'bat', 'sql', 'lua', 'ipynb']],
  ['🎵', ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']],
  ['🎬', ['mp4', 'mov', 'mkv', 'webm', 'avi']],
  ['📦', ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz']],
  ['🔤', ['ttf', 'otf', 'woff', 'woff2']],
  ['🚀', ['exe', 'msi', 'dmg', 'app', 'apk']],
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

function sameFile(a: string, b: string): boolean {
  // Windows paths compare without case and without slash direction.
  if (/^[A-Za-z]:/.test(a) || /^[A-Za-z]:/.test(b)) {
    return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
  }
  return a === b
}

const IGNORED = /[\\/](\.git|node_modules|__pycache__|\.venv)[\\/]/

/** Strings that may name a file: path-like input fields, and tokens of a shell command. */
function candidatesOf(tool: string, input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(input)) {
    const values = Array.isArray(v) ? v : [v]
    for (const one of values) {
      if (typeof one !== 'string') continue
      if (k === 'command' && (tool === 'Bash' || tool === 'PowerShell')) out.push(...shellTokens(one))
      else if (/path|file|output|dest|target|save/i.test(k) && one.length < 1024) out.push(one)
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
    if (token === '' || token.includes('://') || token.startsWith('-')) continue
    if (/[\\/]/.test(token) || /\.[A-Za-z0-9]{1,8}$/.test(token)) out.push(token)
    if (out.length >= 40) break
  }

  return out
}

// ---------- tracking ----------

async function track($: EngineInterface, raw: string[], since: number) {
  const cwd = await $.session.cwd()
  const seen = new Set<string>()
  const found: string[] = []
  const consider = async (path: string) => {
    const abs = isAbsolute(path) ? path : `${cwd}/${path.replace(/^\.[\\/]/, '')}`
    if (seen.has(abs.toLowerCase())) return
    seen.add(abs.toLowerCase())
    try {
      const st = await $.fs.stat(abs, { resolve: true })
      if (st.kind !== 'file' || st.mtimeMs < since - MTIME_SLACK_MS) return
      const real = st.realPath ?? abs
      if (!IGNORED.test(real)) found.push(real)
    } catch {
      // Not a file on disk: not an artifact.
    }
  }

  for (const path of raw) await consider(path)

  // Files a command wrote without naming them: the working directory's top level.
  try {
    for (const entry of await $.fs.list(cwd)) {
      if (entry.kind === 'file' && entry.mtimeMs >= since - MTIME_SLACK_MS) await consider(`${cwd}/${entry.name}`)
    }
  } catch {
    // An unreadable working directory adds nothing.
  }

  if (found.length === 0) return
  const before = (await read($, artifacts)).length
  const now = Date.now()
  await update($, artifacts, list => {
    const rest = list.filter(a => !found.some(p => sameFile(p, a.path)))
    const fresh = found.map(path => list.find(a => sameFile(a.path, path)) ?? { path, addedAt: now })

    return [...fresh, ...rest]
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

/** Drops every artifact whose file is gone from disk. */
async function prune($: EngineInterface) {
  const list = await read($, artifacts)
  const gone: string[] = []
  for (const a of list) {
    if (!(await $.fs.exists(a.path))) gone.push(a.path)
  }
  if (gone.length === 0) return
  await update($, artifacts, l => l.filter(a => !gone.includes(a.path)))
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
    await $.command.register({
      name: 'artifacts',
      description: 'Show the files produced in this session',
    })

    if ((await read($, artifacts)).length === 0) {
      const saved = await $.store.get(await storeKey($))
      if (Array.isArray(saved) && saved.length > 0) {
        await update($, artifacts, () => saved as Artifact[])
      }
    }
    await prune($)
    $.clock.every(PRUNE_EVERY_MS, () => void prune($))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'artifacts' }, async $ => {
    await prune($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Artifacts pane opened. Tab selects, Enter or double-click opens.' }
  })

  on('tool.call', async ($, e, next) => {
    const since = Date.now()
    const ran = await next(e)
    if (ran.deny === undefined && ran.isReadOnly !== true) {
      const raw = candidatesOf(String(e.tool), e as unknown as Record<string, unknown>)
      try {
        await track($, raw, since)
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
