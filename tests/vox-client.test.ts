import { expect, test } from 'claude-code/testing'

import { GAZE_TIMEOUT_MS, VOX_CELL_COLUMNS, VOX_CELL_ROWS, VOX_FRAME_MS, VOX_STATES } from '../hooks/lib'
import VoxClient, { VOX_CLIENT_START, reduceVox, voxRows } from '../hooks/vox-client'
import type { VoxClientState } from '../hooks/vox-client'

const BOX = { columns: VOX_CELL_COLUMNS, rows: VOX_CELL_ROWS }
const point = (type: 'enter' | 'move' | 'leave' | 'down' | 'up', x: number, y: number, fine?: { x: number; y: number }) => ({ type, x, y, ...(fine === undefined ? {} : { fine }) })
const ticks = (s: VoxClientState, n: number, vox: (typeof VOX_STATES)[number] = 'run'): VoxClientState => {
  for (let i = 0; i < n; i++) s = reduceVox(s, { type: 'tick', vox })
  return s
}

test('a pointer event sets the gaze, a leave clears it and a bad event changes nothing', () => {
  let s = ticks(VOX_CLIENT_START, 3)
  s = reduceVox(s, { type: 'pointer', event: point('enter', 29, 11), box: BOX })
  expect(s.gaze).toEqual({ x: 2, y: 1 })
  s = reduceVox(s, { type: 'pointer', event: point('move', 0, 0), box: BOX })
  expect(s.gaze).toEqual({ x: -2, y: -1 })
  s = reduceVox(s, { type: 'pointer', event: point('move', 15, 6, { x: 15.2, y: 6.1 }), box: BOX })
  expect(s.gaze).toEqual({ x: 0, y: 0 })
  const kept = reduceVox(s, { type: 'pointer', event: point('move', Number.NaN, 6), box: BOX })
  expect(kept).toBe(s)
  s = reduceVox(s, { type: 'pointer', event: point('leave', 29, 11), box: BOX })
  expect(s.gaze).toBeNull()
  expect(reduceVox(s, { type: 'pointer', event: point('leave', 0, 0), box: BOX })).toBe(s)
})

test('the gaze clears after six seconds without a pointer event and a move renews it', () => {
  const frames = Math.ceil(GAZE_TIMEOUT_MS / VOX_FRAME_MS)
  let s = ticks(VOX_CLIENT_START, 10)
  s = reduceVox(s, { type: 'pointer', event: point('move', 29, 6), box: BOX })
  expect(s.gaze).toEqual({ x: 2, y: 0 })
  s = ticks(s, frames - 1)
  expect(s.gaze).toEqual({ x: 2, y: 0 })
  s = reduceVox(s, { type: 'pointer', event: point('move', 0, 6), box: BOX })
  s = ticks(s, frames - 1)
  expect(s.gaze).toEqual({ x: -2, y: 0 })
  s = ticks(s, 1)
  expect(s.gaze).toBeNull()
  s = ticks(s, 5)
  expect(s.gaze).toBeNull()
})

test('a state change after the first tick starts a celebration clock and the first state never does', () => {
  let s = ticks(VOX_CLIENT_START, 2, 'run')
  expect([s.vox, s.entered]).toEqual(['run', -1])
  s = ticks(s, 4, 'done')
  expect(s.vox).toBe('done')
  expect(s.entered).toBe(3)
  const same = ticks(s, 3, 'done')
  expect(same.entered).toBe(3)
})

test('the module draws rows of width-1 spans made of space, upper-half and lower-half block glyphs only, with hex colors', () => {
  for (const state of VOX_STATES) for (const frame of [0, 7, 40]) {
    const rows = voxRows({ state, hex: '#3DF58A' }, { ...VOX_CLIENT_START, frame, vox: state, gaze: { x: 1, y: -1 } })
    expect(rows).toHaveLength(VOX_CELL_ROWS)
    for (const row of rows) {
      expect([...row.map(sp => sp.text).join('')]).toHaveLength(VOX_CELL_COLUMNS)
      for (const sp of row) {
        expect(sp.text).toMatch(/^[ ▀▄]+$/)
        for (const c of [sp.fg, sp.bg]) expect(c === undefined || /^#[0-9a-f]{6}$/.test(c)).toBe(true)
      }
    }
  }
})

type FakeSurface = {
  elements: { Box: string; Text: string }
  state: VoxClientState | undefined
  columns: number
  rows: number
  everyCalls: number
  pointerCalls: number
  tick: () => void
  setState: (s: VoxClientState) => void
  every: (ms: number, fn: () => void) => void
  onPointer: (fn: (e: unknown) => void) => void
}

function fakeSurface(): FakeSurface {
  let ticker: (() => void) | undefined
  const s: FakeSurface = {
    elements: { Box: 'Box', Text: 'Text' },
    state: undefined,
    columns: VOX_CELL_COLUMNS,
    rows: VOX_CELL_ROWS,
    everyCalls: 0,
    pointerCalls: 0,
    tick: () => ticker?.(),
    setState: next => {
      s.state = next
    },
    every: (_ms, fn) => {
      s.everyCalls++
      ticker = fn
    },
    onPointer: () => {
      s.pointerCalls++
    },
  }
  return s
}

test('rendering the Client twice with the same surface starts one timer and one pointer listener, and new props reach the running timer', () => {
  const surface = fakeSurface()
  const render = (state: (typeof VOX_STATES)[number]) => VoxClient({ state, hex: '#3DF58A' }, surface as never)
  render('run')
  render('run')
  expect([surface.everyCalls, surface.pointerCalls]).toEqual([1, 1])
  surface.tick()
  expect(surface.state?.vox).toBe('run')
  render('done')
  expect([surface.everyCalls, surface.pointerCalls]).toEqual([1, 1])
  surface.tick()
  expect(surface.state?.vox).toBe('done')
  expect(surface.state?.entered).toBeGreaterThan(0)
  const other = fakeSurface()
  VoxClient({ state: 'run', hex: '#3DF58A' }, other as never)
  expect([other.everyCalls, other.pointerCalls]).toEqual([1, 1])
})
