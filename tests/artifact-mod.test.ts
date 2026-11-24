import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  component: 'Pane',
  requestId: 'artifact-mod',
  props: {
    title: 'Artifacts',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Os = 'windows' | 'posix'

/**
 * Each test runs with the fixtures of a Windows session (C:/work) and of a POSIX
 * session (/work). `at` spells a path under the working folder the way a tool
 * would, and `key` is the key of that file's row in the pane.
 */
const OS = {
  windows: {
    root: 'C:/work',
    env: { OS: 'Windows_NT' },
    at: (rel: string) => `C:/work/${rel}`,
    key: (rel: string) => `a:C:\\work\\${rel.replace(/\//g, '\\')}`,
    opener: (rel: string) => ['explorer.exe', `C:\\work\\${rel.replace(/\//g, '\\')}`],
  },
  posix: {
    root: '/work',
    env: {},
    at: (rel: string) => `/work/${rel}`,
    key: (rel: string) => `a:/work/${rel}`,
    opener: (rel: string) => ['xdg-open', `/work/${rel}`],
  },
} as const

/**
 * The runtime resolves a path before an fs stub sees it, and a path from the other
 * OS is not absolute there: on a POSIX host C:\work\x arrives as /<cwd>/C:\work\x, and
 * on a Windows host /work/x arrives with a drive letter. `canon` undoes that and
 * spells the path with forward slashes, so the fake disk finds each file by the path
 * the mod meant, and both sets of fixtures run on every host.
 */
function canon(os: Os, path: string): string {
  let p = path
  if (os === 'windows') {
    const lastDrive = [...p.matchAll(/[A-Za-z]:[\\/]/g)].pop()
    if (lastDrive !== undefined) p = p.slice(lastDrive.index ?? 0)
  } else {
    p = p.replace(/^[A-Za-z]:/, '')
  }

  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

/**
 * A fake disk: `files` already exist; a writing tool creates the file it names, "now".
 * `withStore: false` leaves `$.store` for the test to stub.
 */
function disk(on: On, os: Os, files: Set<string>, opened: string[][], bashWrites: string[] = [], withStore = true) {
  if (withStore) mock.store(on)
  mock.env(on, OS[os].env)
  on('session.cwd', () => ({ value: OS[os].root }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('fs.list', (_$, e) => {
    const dir = `${canon(os, e.path).replace(/\/$/, '')}/`
    return {
      value: [...files]
        .filter(p => p.toLowerCase().startsWith(dir.toLowerCase()) && !p.slice(dir.length).includes('/'))
        .map(p => ({ name: p.slice(dir.length), kind: 'file' as const, size: 1, isLink: false, mtimeMs: Date.now() })),
    }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(canon(os, e.path)) }))
  on('fs.stat', (_$, e) => {
    const path = canon(os, e.path)
    if (!files.has(path)) return { deny: 'ENOENT' }
    return { value: { kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false, realPath: path } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    opened.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The engine marks read-only tools' results; Read and the screenshot tool stand in for them here.
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    const target = input.file_path ?? input.filename
    if (e.tool !== 'Read' && typeof target === 'string') files.add(canon(os, target))
    if (e.tool === 'Bash') for (const p of bashWrites) files.add(p)
    return e.tool === 'Read' || e.tool === 'mcp__playwright__browser_take_screenshot'
      ? { result: {}, text: 'ok', isReadOnly: true as const }
      : { result: {}, text: 'ok' }
  })
}

const mount = ($: any, surface: 'terminal' | 'desktop' = 'terminal') => $.ui.mount({ plugin: 'powermods-artifacts', surface, ...PANE })

for (const os of ['windows', 'posix'] as const) {
  const { at, key, opener } = OS[os]

  describe(`artifact-mod (${os})`, () => {
    test('a written file is listed with its icon, opened on Enter, dropped once deleted', async ($, on) => {
      const files = new Set<string>()
      const opened: string[][] = []
      disk(on, os, files, opened)

      await $.tool.call({ tool: 'Write', file_path: at('chart.png'), content: 'x' })

      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await mount($, surface)
        const row = await ui.find({ key: key('chart.png') })
        expect(row?.text).toContain('🎨 chart.png')
        await ui.unmount()
      }

      const ui = await mount($)
      await ui.press({ key: key('chart.png') }) // selects
      await ui.press({ key: key('chart.png') }) // second press opens
      expect(opened).toContainEqual(opener('chart.png'))

      files.delete(at('chart.png'))
      await ui.press({ key: 'open' })
      expect(await ui.find({ key: key('chart.png') })).toBeUndefined()
      await ui.unmount()
    })

    test('many artifacts page through Next', async ($, on) => {
      disk(on, os, new Set(), [])

      for (let i = 0; i < 15; i++) await $.tool.call({ tool: 'Write', file_path: at(`f${i}.txt`), content: 'x' })

      const ui = await mount($)
      expect(await ui.find({ text: /page 1\/3/ })).toBeDefined()
      await ui.press({ key: 'next' })
      expect(await ui.find({ text: /page 2\/3/ })).toBeDefined()
      await ui.unmount()
    })

    test('read-only tools add nothing', async ($, on) => {
      disk(on, os, new Set([at('a.md')]), [])

      await $.tool.call({ tool: 'Read', file_path: at('a.md') })

      const ui = await mount($)
      expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
      await ui.unmount()
    })

    test('a read-only tool that saves a file still lists it', async ($, on) => {
      disk(on, os, new Set(), [])

      await $.tool.call({
        tool: 'mcp__playwright__browser_take_screenshot',
        filename: at('assets/shot.png'),
        scale: 'css',
      })

      const ui = await mount($)
      expect(await ui.find({ key: key('assets/shot.png') })).toBeDefined()
      await ui.unmount()
    })

    test('one file reached by two spellings is listed once', async ($, on) => {
      disk(on, os, new Set(), [])

      // The cwd scan finds the same file the tool input spells another way:
      // with backslashes on Windows, with a doubled slash on POSIX.
      const spelled = os === 'windows' ? 'C:\\work\\NOTES.md' : '/work//NOTES.md'
      await $.tool.call({ tool: 'Write', file_path: spelled, content: 'x' })

      const ui = await mount($)
      expect(await ui.find({ text: /^1 artifact$/ })).toBeDefined()
      await ui.unmount()
    })

    test('background task .output logs are not listed', async ($, on) => {
      disk(on, os, new Set(), [])

      const log = os === 'windows' ? 'C:/tmp/claude/tasks/b1.output' : '/tmp/claude/tasks/b1.output'
      await $.tool.call({ tool: 'Write', file_path: log, content: 'x' })

      const ui = await mount($)
      expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
      await ui.unmount()
    })

    test('code and config files are not listed', async ($, on) => {
      disk(on, os, new Set(), [])

      await $.tool.call({ tool: 'Write', file_path: at('hooks/register.tsx'), content: 'x' })
      await $.tool.call({ tool: 'Write', file_path: at('package.json'), content: '{}' })

      const ui = await mount($)
      expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
      await ui.unmount()
    })

    test('editing a file that existed before the session is not listed', async ($, on) => {
      disk(on, os, new Set([at('README.md'), at('assets/logo.png')]), [])

      const readme = os === 'windows' ? 'C:\\work\\README.md' : at('README.md')
      await $.tool.call({ tool: 'Edit', file_path: readme, old_string: 'a', new_string: 'b' })
      await $.tool.call({ tool: 'Write', file_path: at('assets/logo.png'), content: 'x' })

      const ui = await mount($)
      expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
      await ui.unmount()
    })

    test('a shell command writing to $PWD/... lists the file', async ($, on) => {
      disk(on, os, new Set(), [], [at('docs/images/panel.svg'), at('docs/images/panel.png')])

      await $.tool.call({
        tool: 'Bash',
        command:
          'python mock.py docs/images/panel.svg && chrome.exe --headless=new ' +
          '--screenshot="$(cygpath -w "$PWD/docs/images/panel.png")" "file:///$(cygpath -m "$PWD/docs/images/panel.svg")"',
      })

      const ui = await mount($)
      expect(await ui.find({ key: key('docs/images/panel.png') })).toBeDefined()
      expect(await ui.find({ key: key('docs/images/panel.svg') })).toBeDefined()
      await ui.unmount()
    })

    test('an unnamed output beside a named file is listed', async ($, on) => {
      disk(on, os, new Set([at('docs/old.png')]), [], [at('docs/chart.png')])

      await $.tool.call({ tool: 'Bash', command: 'render docs/old.png --out "$OUT_DIR"' })

      const ui = await mount($)
      expect(await ui.find({ key: key('docs/chart.png') })).toBeDefined()
      expect(await ui.find({ text: /^1 artifact$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a file this session made stays listed when rewritten', async ($, on) => {
      disk(on, os, new Set(), [])

      await $.tool.call({ tool: 'Write', file_path: at('report.pdf'), content: 'v1' })
      await $.tool.call({ tool: 'Write', file_path: at('report.pdf'), content: 'v2' })

      const ui = await mount($)
      expect(await ui.find({ key: key('report.pdf') })).toBeDefined()
      expect(await ui.find({ text: /^1 artifact$/ })).toBeDefined()
      await ui.unmount()
    })
  })
}

const DAY = 24 * 60 * 60 * 1000

/** A store the test can read back, in place of mock.store */
function fakeStore(on: On, store: Map<string, unknown>, deleted: string[] = []) {
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    deleted.push(e.key)
    store.delete(e.key)
    return { value: undefined }
  })
}

describe('the saved lists in $.store', () => {
  test('a new file is saved under this session with the time it was saved', async ($, on) => {
    const store = new Map<string, unknown>()
    disk(on, 'posix', new Set(), [], [], false)
    fakeStore(on, store)

    const before = Date.now()
    await $.tool.call({ tool: 'Write', file_path: '/work/chart.png', content: 'x' })

    const saved = store.get('session:sid-1') as { updatedAt: number; artifacts: { path: string }[] }
    expect(saved.artifacts.map(a => a.path)).toEqual(['/work/chart.png'])
    expect(saved.updatedAt).toBeGreaterThanOrEqual(before)
  })

  test("session start deletes other sessions' lists after 30 days and keeps the rest", async ($, on) => {
    const now = Date.now()
    const store = new Map<string, unknown>([
      ['session:old', { updatedAt: now - 31 * DAY, artifacts: [{ path: '/work/a.png', addedAt: now - 40 * DAY }] }],
      ['session:recent', { updatedAt: now - 2 * DAY, artifacts: [{ path: '/work/b.png', addedAt: now - 2 * DAY }] }],
      // The older shape, a bare array, is dated by its newest file
      ['session:old-array', [{ path: '/work/c.png', addedAt: now - 45 * DAY }]],
      ['session:recent-array', [{ path: '/work/d.png', addedAt: now - 3 * DAY }]],
      ['session:sid-1', { updatedAt: now - 90 * DAY, artifacts: [{ path: '/work/mine.png', addedAt: now - 90 * DAY }] }],
      ['other', 'kept'],
    ])
    const deleted: string[] = []
    disk(on, 'posix', new Set(['/work/mine.png']), [], [], false)
    fakeStore(on, store, deleted)
    on('session.start', () => ({ cwd: '/work' }))
    on('command.register', () => ({ value: { command: 'local-artifacts' } }))
    mock.clock(on, { now })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    expect(deleted.sort()).toEqual(['session:old', 'session:old-array'])
    expect([...store.keys()].sort()).toEqual(['other', 'session:recent', 'session:recent-array', 'session:sid-1'])
    // This session's own list is restored and saved again, which keeps it another 30 days
    expect((store.get('session:sid-1') as { updatedAt: number }).updatedAt).toBeGreaterThanOrEqual(now)
    const ui = await mount($)
    expect(await ui.find({ key: 'a:/work/mine.png' })).toBeDefined()
    await ui.unmount()
  })
})
