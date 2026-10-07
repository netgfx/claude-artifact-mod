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

/** A fake disk: paths that exist, each written "now". */
const KEY = 'a:C:\\work\\chart.png'
const norm = (p: string) => p.replace(/\\/g, '/')
function disk(on: On, files: Set<string>, opened: string[][]) {
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT' })
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('fs.list', () => ({ value: [] }))
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
  // The engine marks read-only tools' results; Read stands in for them here.
  on('tool.call', (_$, e) =>
    e.tool === 'Read'
      ? { result: {}, text: 'ok', isReadOnly: true as const }
      : { result: {}, text: 'ok' },
  )
}

describe('artifact-mod', () => {
  test('a written file is listed with its icon, opened on Enter, dropped once deleted', async ($, on) => {
    const files = new Set(['C:/work/chart.png'])
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
    const files = new Set<string>()
    for (let i = 0; i < 15; i++) files.add(`C:/work/f${i}.txt`)
    disk(on, files, [])

    for (const path of files) await $.tool.call({ tool: 'Write', file_path: path, content: 'x' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect((await ui.find({ text: /page 1\/3/ }))).toBeDefined()
    await ui.press({ key: 'next' })
    expect((await ui.find({ text: /page 2\/3/ }))).toBeDefined()
    await ui.unmount()
  })

  test('read-only tools add nothing', async ($, on) => {
    const files = new Set(['C:/work/a.md'])
    disk(on, files, [])

    await $.tool.call({ tool: 'Read', file_path: 'C:/work/a.md' })

    const ui = await $.ui.mount({ plugin: 'artifact-mod', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No artifacts yet/ })).toBeDefined()
    await ui.unmount()
  })
})
