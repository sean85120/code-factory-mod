import { readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_THEME_CAPS, VOX_STATES, faceCells, hackerTheme, poseAt, unpackCells } from '../hooks/lib'
import type { VoxState } from '../hooks/lib'

type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[] }
type Scene = { name: string; component: string; surface: string; columns: number; look: string; root: Node }

const NAMED: Record<string, string> = {
  green: '#3fb950',
  yellow: '#d29922',
  red: '#f85149',
  cyan: '#39c5cf',
  magenta: '#bc8cff',
  blue: '#58a6ff',
  white: '#e6edf3',
  gray: '#8b949e',
  grey: '#8b949e',
  black: '#0d1117',
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const color = (c: unknown): string | undefined => (typeof c === 'string' ? (c.startsWith('#') ? c : NAMED[c]) : undefined)
const n = (v: unknown): number => (typeof v === 'number' ? v : 0)

function hex(word: number, fallback: string): string {
  if (word === 0x01000000) return fallback
  return `#${(word & 0xffffff).toString(16).padStart(6, '0')}`
}

function raster(columns: number, rows: number, cells: string, fg0: string, bg0: string): string {
  const w = unpackCells(cells)
  const out: string[] = []
  for (let y = 0; y < rows; y++) {
    const row: string[] = []
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 3
      const cp = w[i]!
      const fg = hex(w[i + 1]!, fg0)
      const bg = hex(w[i + 2]!, bg0)
      const bgStyle = cp === 0x2580 ? `linear-gradient(${fg} 50%,${bg} 50%)` : cp === 0x2584 ? `linear-gradient(${bg} 50%,${fg} 50%)` : cp === 0x2588 ? fg : bg
      row.push(`<i style="background:${bgStyle}"></i>`)
    }
    out.push(`<div class="rr">${row.join('')}</div>`)
  }
  return `<div class="raster">${out.join('')}</div>`
}

function render(node: Node | string, dark: boolean): string {
  if (typeof node === 'string') return esc(node)
  const p = node.props ?? {}
  const kids = (node.children ?? []).map(c => render(c, dark)).join('')
  const style: string[] = []
  const bg = color(p.backgroundColor)
  if (bg) style.push(`background:${bg}`)
  switch (node.type) {
    case 'Box': {
      style.push(`flex-direction:${p.flexDirection === 'column' ? 'column' : 'row'}`)
      if (typeof p.gap === 'number') style.push(`gap:${p.gap}ch`)
      if (typeof p.paddingX === 'number') style.push(`padding-left:${p.paddingX}ch;padding-right:${p.paddingX}ch`)
      if (typeof p.paddingLeft === 'number') style.push(`padding-left:${p.paddingLeft}ch`)
      return `<div class="box" style="${style.join(';')}">${kids}</div>`
    }
    case 'Text':
    case 'Button': {
      const c = color(p.color)
      if (c) style.push(`color:${c}`)
      const cls = ['t']
      if (p.bold) cls.push('b')
      if (p.dimColor) cls.push('d')
      if (p.inverse) cls.push('inv')
      if (p.wrap === 'truncate-end' || p.wrap === 'truncate') cls.push('trunc')
      if (node.type === 'Button') cls.push('btn')
      const text = kids === '' && typeof p.label === 'string' ? esc(p.label) : kids
      if (/^\s*(──|--) /.test(text.replace(/&nbsp;/g, ' '))) cls.push('trunc')
      const body = text === '' ? '&nbsp;' : text.trim() === '' ? text.replace(/ /g, '&nbsp;') : text
      return `<span class="${cls.join(' ')}" style="${style.join(';')}">${body}</span>`
    }
    case 'Raster':
      return raster(n(p.columns), n(p.rows), String(p.cells), '#d7ffe8', '#0d1117')
    case 'Svg':
      return `<div class="svg" title="${esc(String(p.alt ?? ''))}">${String(p.source ?? '')}</div>`
    default:
      return kids
  }
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#05070a}
body{padding:28px;display:inline-block;font:14px/1.32 "SF Mono",Menlo,Monaco,"Courier New",monospace;color:#e6edf3}
.win{border-radius:12px;overflow:hidden;border:1px solid #2a2f37;box-shadow:0 18px 50px rgba(0,0,0,.55);background:#0d1117}
.bar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#161b22;border-bottom:1px solid #2a2f37;font-size:12px;color:#8b949e}
.dot{width:12px;height:12px;border-radius:50%;display:inline-block}
.bar b{margin-left:10px;font-weight:500}
.body{padding:12px 14px 14px}
.win.light{border-color:#d0d7de;background:#f6f8fa}
.light .bar{background:#eaeef2;border-color:#d0d7de;color:#57606a}
.box{display:flex;min-width:0}
.t{white-space:pre-wrap;min-width:0}
.t.b{font-weight:700}.t.d{opacity:.55}.t.inv{background:#e6edf3;color:#0d1117}
.t.trunc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{cursor:pointer}
.raster{display:flex;flex-direction:column}
.rr{display:flex;height:1.32em}
.rr i{display:block;width:1ch;height:100%}
.svg{display:block}
.prompt{margin-top:10px;padding-top:8px;border-top:1px solid #21262d;color:#8b949e}
.prompt span{color:#3fb950}
.sheet{display:grid;grid-template-columns:repeat(4,auto);gap:22px 34px;justify-content:start}
.cell .name{margin-top:6px;text-align:center;font-weight:700}
.cell .sub{text-align:center;font-size:12px;opacity:.6}
`

const PAGE = (inner: string, id: string): string => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body id="${id}">${inner}<script>document.body.setAttribute('data-w',Math.ceil(document.body.getBoundingClientRect().width));document.body.setAttribute('data-h',Math.ceil(document.body.getBoundingClientRect().height))</script></body></html>`

function frame(title: string, width: string, inner: string, light = false, prompt = false): string {
  const dots = light ? ['#ff5f57', '#febc2e', '#28c840'] : ['#ff5f57', '#febc2e', '#28c840']
  return `<div class="win${light ? ' light' : ''}" style="width:${width}"><div class="bar">${dots.map(d => `<span class="dot" style="background:${d}"></span>`).join('')}<b>${esc(title)}</b></div><div class="body">${inner}${prompt ? '<div class="prompt"><span>❯</span> </div>' : ''}</div></div>`
}

const TITLES: Record<string, string> = {
  'band-hacker': 'claude · code-factory · hacker look · the band above the prompt',
  'band-classic': 'claude · code-factory · classic look · the band above the prompt',
  'pane-hacker': 'claude · code-factory · hacker look · /factory-dashboard',
  'pane-classic': 'claude · code-factory · classic look · /factory-dashboard',
  'pane-agent': 'claude · code-factory · hacker look · pressing an agent shows what it is doing',
  'band-hold': 'claude · code-factory · hacker look · the loop is held: why, and the next command',
  'band-stuck': 'claude · code-factory · hacker look · five quiet minutes: the stuck warning',
  'pane-hold': 'claude · code-factory · hacker look · /factory-dashboard while the loop is held',
  'pane-stuck': 'claude · code-factory · hacker look · /factory-dashboard with the stuck warning',
  'pane-desktop': 'Claude desktop · code-factory · hacker look · factory pane',
}

function scenePage(s: Scene): string {
  const dark = s.surface !== 'desktop' || s.look === 'hacker'
  const root: Node = { ...s.root, children: (s.root.children ?? []).filter(c => !(typeof c !== 'string' && c.type === 'Text' && (c.children ?? []).join('') === 'base')) }
  const inner = render(root, dark)
  const width = `calc(${s.columns}ch + 28px)`
  return PAGE(frame(TITLES[s.name] ?? s.name, width, inner, s.surface === 'desktop', s.component === 'AbovePrompt'), s.name)
}

function voxSheet(): string {
  const t = hackerTheme(DEFAULT_THEME_CAPS)
  const label: Record<VoxState, string> = { run: 'working', review: 'reviewing', done: 'done', hold: 'paused', blocked: 'blocked', budget: 'budget reached', idle: 'idle' }
  const sub: Record<VoxState, string> = { run: 'blinks, eyes drift', review: 'scans, glint sweeps', done: 'two hops, sparkles', hold: 'asleep, floating z', blocked: 'one shake, red', budget: 'coin eyes spin', idle: 'blinks' }
  const cells = VOX_STATES.map(s => {
    const since = s === 'done' || s === 'blocked' || s === 'budget' ? 260 : Infinity
    const pose = poseAt(s, s === 'run' ? 1500 : s === 'review' ? 0 : 1200, since)
    const tone = t.vox[s] ?? '#3DF58A'
    const f = faceCells(pose, tone)
    return `<div class="cell">${raster(f.columns, f.rows, f.cells, '#d7ffe8', '#0d1117')}<div class="name" style="color:${tone}">${label[s]}</div><div class="sub">${sub[s]}</div></div>`
  })
  return PAGE(frame('Vox, the factory mascot · seven states', 'calc(4 * 22ch + 3 * 34px + 28px)', `<div class="sheet">${cells.join('')}</div>`), 'vox-states')
}

const dir = process.argv[2]!
const lines = readFileSync(`${dir}/scenes.jsonl`, 'utf8').split('\n').filter(l => l.trim() !== '')
for (const l of lines) {
  const s = JSON.parse(l) as Scene
  writeFileSync(`${dir}/${s.name}.html`, scenePage(s))
}
writeFileSync(`${dir}/vox-states.html`, voxSheet())
