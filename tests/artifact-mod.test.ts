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

/** A fake disk: `files` already exist; a writing tool creates the file it names, "now". */
const KEY = 'a:C:\\work\\chart.png'
const norm = (p: string) => p.replace(/\\/g, '/')
function disk(on: On, files: Set<string>, opened: string[][], bashWrites: string[] = []) {
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT' })
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('fs.list', (_$, e) => {
    const dir = `${norm(e.path).replace(/\/$/, '')}/`
    return {
      value: [...files]
        .filter(p => p.toLowerCase().startsWith(dir.toLowerCase()) && !p.slice(dir.length).includes('/'))
        .map(p => ({ name: p.slice(dir.length), kind: 'file' as const, mtimeMs: Date.now() })),
    }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.stat', (_$, e) => {
    if (!files.has(norm(e.path))) return { deny: 'ENOENT' }
    return { value: { kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false, realPath: e.path } }
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
    if (e.tool !== 'Read' && typeof target === 'string') files.add(norm(target))
    if (e.tool === 'Bash') for (const p of bashWrites) files.add(p)
    return e.tool === 'Read' || e.tool === 'mcp__playwright__browser_take_screenshot'
      ? { result: {}, text: 'ok', isReadOnly: true as const }
      : { result: {}, text: 'ok' }
  })
}

describe('artifact-mod', () => {
  test('a written file is listed with its icon, opened on Enter, dropped once deleted', async ($, on) => {
    const files = new Set<string>()
    const opened: string[][] = []
    disk(on, files, opened)

    await $.tool.call({ tool: 'Write', file_path: 'C:/work/chart.png', content: 'x' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'artifact-mod', surface, ...PANE })
      const row = await ui.find({ key: KEY })
      expect(row?.text).toContain('🎨 chart.png')
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    await ui.press({ key: KEY }) // selects
    await ui.press({ key: KEY }) // second press opens
    expect(opened).toContainEqual(['explorer.exe', 'C:\\work\\chart.png'])

    files.delete('C:/work/chart.png')
    await ui.press({ key: 'open' })
    expect(await ui.find({ key: KEY })).toBeUndefined()
    await ui.unmount()
  })

  test('many artifacts page through Next', async ($, on) => {
    disk(on, new Set(), [])

    for (let i = 0; i < 15; i++) await $.tool.call({ tool: 'Write', file_path: `C:/work/f${i}.txt`, content: 'x' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect((await ui.find({ text: /page 1\/3/ }))).toBeDefined()
    await ui.press({ key: 'next' })
    expect((await ui.find({ text: /page 2\/3/ }))).toBeDefined()
    await ui.unmount()
  })

  test('read-only tools add nothing', async ($, on) => {
    disk(on, new Set(['C:/work/a.md']), [])

    await $.tool.call({ tool: 'Read', file_path: 'C:/work/a.md' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('a read-only tool that saves a file still lists it', async ($, on) => {
    disk(on, new Set(), [])

    await $.tool.call({
      tool: 'mcp__playwright__browser_take_screenshot',
      filename: 'C:/work/assets/shot.png',
      scale: 'css',
    })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'a:C:\\work\\assets\\shot.png' })).toBeDefined()
    await ui.unmount()
  })

  test('one file reached by two spellings is listed once', async ($, on) => {
    disk(on, new Set(), [])

    // The cwd scan finds the same file the tool input names with backslashes.
    await $.tool.call({ tool: 'Write', file_path: 'C:\\work\\NOTES.md', content: 'x' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /^1 artifact$/ })).toBeDefined()
    await ui.unmount()
  })

  test('background task .output logs are not listed', async ($, on) => {
    disk(on, new Set(), [])

    await $.tool.call({ tool: 'Write', file_path: 'C:/tmp/claude/tasks/b1.output', content: 'x' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('code and config files are not listed', async ($, on) => {
    disk(on, new Set(), [])

    await $.tool.call({ tool: 'Write', file_path: 'C:/work/hooks/register.tsx', content: 'x' })
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/package.json', content: '{}' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('editing a file that existed before the session is not listed', async ($, on) => {
    disk(on, new Set(['C:/work/README.md', 'C:/work/assets/logo.png']), [])

    await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\README.md', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/assets/logo.png', content: 'x' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('a shell command writing to $PWD/... lists the file', async ($, on) => {
    disk(on, new Set(), [], ['C:/work/docs/images/panel.svg', 'C:/work/docs/images/panel.png'])

    await $.tool.call({
      tool: 'Bash',
      command:
        'python mock.py docs/images/panel.svg && chrome.exe --headless=new ' +
        '--screenshot="$(cygpath -w "$PWD/docs/images/panel.png")" "file:///$(cygpath -m "$PWD/docs/images/panel.svg")"',
    })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'a:C:\\work\\docs\\images\\panel.png' })).toBeDefined()
    expect(await ui.find({ key: 'a:C:\\work\\docs\\images\\panel.svg' })).toBeDefined()
    await ui.unmount()
  })

  test('an unnamed output beside a named file is listed', async ($, on) => {
    disk(on, new Set(['C:/work/docs/old.png']), [], ['C:/work/docs/chart.png'])

    await $.tool.call({ tool: 'Bash', command: 'render docs/old.png --out "$OUT_DIR"' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'a:C:\\work\\docs\\chart.png' })).toBeDefined()
    expect(await ui.find({ text: /^1 artifact$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a file this session made stays listed when rewritten', async ($, on) => {
    disk(on, new Set(), [])

    await $.tool.call({ tool: 'Write', file_path: 'C:/work/report.pdf', content: 'v1' })
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/report.pdf', content: 'v2' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'a:C:\\work\\report.pdf' })).toBeDefined()
    expect(await ui.find({ text: /^1 artifact$/ })).toBeDefined()
    await ui.unmount()
  })
})
