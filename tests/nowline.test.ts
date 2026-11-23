import { expect, test } from 'claude-code/testing'

import { DEFAULT_THEME_CAPS, STUCK_MS, activityLine, buildView, DEFAULT_STATE, hackerTheme, holdLine, liveLine, nowLine, parseTodo, statusLine, stuckLine } from '../hooks/lib'
import type { FactoryView, Mark } from '../hooks/lib'

const view = (o: Partial<FactoryView> = {}): FactoryView => ({
  approved: true,
  running: false,
  pausedReason: null,
  current: null,
  stage: null,
  summary: '',
  doneCount: 0,
  rows: [],
  more: 0,
  marks: {},
  changes: [],
  runUsd: null,
  itemUsd: null,
  budgetUsd: 0,
  events: [],
  total: 0,
  blockedCount: 0,
  ...o,
})

const marks = (m: Record<string, Mark>): Partial<FactoryView> => ({
  marks: m,
  blockedCount: Object.values(m).filter(x => x === 'blocked').length,
  doneCount: Object.values(m).filter(x => x === 'done').length,
  total: Object.values(m).filter(x => x !== 'proposed').length,
  rows: Object.entries(m)
    .filter(([, x]) => x !== 'done')
    .map(([id, mark]) => ({ id, type: 'feature' as const, title: 't', version: '', mark })),
})

const run = (o: Partial<FactoryView> = {}): FactoryView => view({ running: true, current: 'T-009', stage: 'build', attempt: 2, maxAttempts: 4, reviewRound: 0, maxReviewRounds: 3, prNumber: null, ...o })

test('nowLine says what the running loop is doing at every stage, with attempt, review round and PR number', () => {
  expect(nowLine(run())).toBe('Building T-009, attempt 2/4')
  expect(nowLine(run({ attempt: 0 }))).toBe('Building T-009, attempt 1/4')
  expect(nowLine(run({ stage: 'review', reviewRound: 1 }))).toBe('Reviewing T-009, round 1/3')
  expect(nowLine(run({ stage: 'review', reviewRound: 0 }))).toBe('Reviewing T-009, round 1/3')
  expect(nowLine(run({ stage: 'PR' }))).toBe('Opening the PR for T-009')
  expect(nowLine(run({ stage: 'PR', prNumber: 12 }))).toBe('PR #12 open: waiting for CI')
  expect(nowLine(run({ stage: 'CI', prNumber: 12 }))).toBe('PR #12 open: waiting for CI')
  expect(nowLine(run({ stage: 'CI' }))).toBe('Waiting for CI on T-009')
  expect(nowLine(run({ stage: 'CI', prNumber: 12, steps: [{ label: 'CI', state: 'doing', detail: 'failed' }] }))).toBe('PR #12 open: CI failed, fixing')
  expect(nowLine(run({ stage: 'merge', prNumber: 12 }))).toBe('Merging PR #12')
  expect(nowLine(run({ stage: 'merge' }))).toBe('Merging T-009')
  const merged = [{ label: 'merge', state: 'done' as const, detail: 'merged' }]
  expect(nowLine(run({ stage: 'merge', prNumber: 12, steps: merged }))).toBe('T-009 merged: confirming')
  expect(nowLine(run({ stage: 'merge', steps: merged }))).toBe('T-009 merged: confirming')
  expect(nowLine(run({ stage: 'merge', prNumber: 12, steps: [{ label: 'merge', state: 'doing', detail: 'merging' }] }))).toBe('Merging PR #12')
  expect(nowLine(run({ stage: 'merge', current: 'x"y', steps: merged }))).toBe('the item merged: confirming')
  expect(nowLine(view({ steps: merged }))).toBe('')
  expect(nowLine(run({ current: null, stage: null }))).toBe('Picking the next item')
  expect(nowLine(view())).toBe('')
})

test('holdLine names the cause and the exact command, in precedence blocked, budget, approval, your pause, all done', () => {
  const blocked = marks({ 'T-001': 'done', 'T-009': 'blocked', 'T-011': 'blocked' })
  expect(holdLine(view({ ...blocked, pausedReason: 'nothing left to do' }))).toEqual({ why: '2 items blocked: T-009, T-011', next: '/factory-retry T-009' })
  expect(holdLine(view(marks({ 'T-001': 'done', 'T-009': 'blocked' })))).toEqual({ why: '1 item blocked: T-009', next: '/factory-retry T-009' })
  expect(holdLine(view(marks({ a1: 'blocked', 'T-2': 'blocked', 'T-3': 'blocked', 'T-4': 'blocked', 'T-5': 'blocked' })))).toEqual({ why: '5 items blocked: T-2, T-3, T-4 +2 more', next: '/factory-retry T-2' })
  expect(holdLine(view({ ...marks({ 'T-001': 'done', 'T-002': 'todo' }), pausedReason: 'budget reached: $5.00 of $5.00' }))).toEqual({ why: 'budget reached: $5.00 of $5.00', next: '/factory-start' })
  expect(holdLine(view({ ...marks({ 'T-009': 'blocked' }), pausedReason: 'budget reached' })).why).toBe('1 item blocked: T-009')
  expect(holdLine(view({ ...marks({ 'T-001': 'done', 'T-002': 'proposed', 'T-003': 'proposed', 'T-004': 'proposed', 'T-005': 'proposed' }), pausedReason: 'nothing left to do' }))).toEqual({ why: '4 items proposed', next: '/factory-approve' })
  expect(holdLine(view({ ...marks({ 'T-002': 'proposed' }), pausedReason: 'paused by you; /factory-start resumes' }))).toEqual({ why: '1 item proposed', next: '/factory-approve' })
  expect(holdLine(view({ approved: false, ...marks({ 'T-001': 'todo' }) }))).toEqual({ why: 'design not approved', next: '/factory-approve' })
  expect(holdLine(view({ ...marks({ 'T-001': 'todo' }), pausedReason: 'paused by you; /factory-start resumes' }))).toEqual({ why: 'paused by you', next: '/factory-start' })
  expect(holdLine(view({ ...marks({ 'T-001': 'todo' }), pausedReason: 'stopped by you' }))).toEqual({ why: 'stopped by you', next: '/factory-start' })
  expect(holdLine(view({ ...marks({ 'T-001': 'done', 'T-002': 'done' }), pausedReason: 'nothing left to do' }))).toEqual({ why: 'all items merged', next: '/factory-roadmap' })
  expect(holdLine(view({ ...marks({ 'T-001': 'done', 'T-002': 'todo', 'T-003': 'todo' }), pausedReason: 'nothing left to do' }))).toEqual({ why: '2 items to do, none can start', next: '/factory-status' })
  expect(holdLine(view({ ...marks({ 'T-001': 'todo' }), pausedReason: 'approved, not started' }))).toEqual({ why: 'approved, not started', next: '/factory-start' })
  expect(holdLine(view({ ...marks({ 'T-001': 'todo' }) }))).toEqual({ why: 'stopped', next: '/factory-start' })
})

test('a blocked plus proposed view never reads nothing left to do and names the blocked retry first', () => {
  const v = view({ ...marks({ 'T-001': 'done', 'T-009': 'blocked', 'T-010': 'proposed', 'T-011': 'proposed' }), pausedReason: 'nothing left to do' })
  const h = holdLine(v)
  expect(h).toEqual({ why: '1 item blocked: T-009', next: '/factory-retry T-009' })
  for (const t of [undefined, hackerTheme(DEFAULT_THEME_CAPS), hackerTheme(DEFAULT_THEME_CAPS, true)]) {
    const line = statusLine(v, t)
    expect(line).not.toMatch(/nothing left/)
    expect(line).toContain('1 item blocked: T-009 · next /factory-retry T-009')
  }
  expect(liveLine(v)).toBe('Next: /factory-retry T-009')
  expect(liveLine(run({ stage: 'review', reviewRound: 2 }))).toBe('Reviewing T-009, round 2/3')
})

test('the status line carries the stage sentence while running and the cause plus command when held', () => {
  const t = hackerTheme(DEFAULT_THEME_CAPS)
  const a = hackerTheme(DEFAULT_THEME_CAPS, true)
  for (const th of [undefined, t, a]) {
    expect(statusLine(run({ stage: 'review', reviewRound: 1 }), th)).toContain('Reviewing T-009, round 1/3')
    expect(statusLine(run({ stage: 'CI', prNumber: 12 }), th)).toContain('PR #12 open: waiting for CI')
    expect(statusLine(view({ ...marks({ 'T-001': 'todo' }), pausedReason: 'stopped by you' }), th)).toContain('stopped by you · next /factory-start')
  }
  for (const v of [run(), run({ stage: 'review', reviewRound: 1 }), run({ stage: 'merge', prNumber: 3 }), view({ ...marks({ 'T-009': 'blocked' }) }), view({ ...marks({ 'T-002': 'proposed' }) })]) {
    expect(`${liveLine(v)}${holdLine(v).why}${holdLine(v).next}`).toMatch(/^[\x20-\x7e]+$/)
  }
})

test('the lines hold fixed words, ids and numbers only: a hostile title, reason or id never reaches them', () => {
  const evil = '<script>SECRET\u001b[31m'
  const hostile = view({
    ...marks({ 'T-001': 'done', 'T-009': 'blocked', 'T-010': 'proposed' }),
    rows: [
      { id: 'T-009', type: 'feature', title: evil, version: evil, mark: 'blocked' },
      { id: 'T-010', type: 'feature', title: evil, version: evil, mark: 'proposed' },
    ],
    blocked: [{ id: 'T-009', title: evil, reason: evil }],
    pausedReason: 'nothing left to do',
    events: [evil],
    changes: [evil],
    summary: evil,
  })
  const hostileId = view({ ...marks({ [evil]: 'blocked', 'T-002': 'proposed' }), pausedReason: 'nothing left to do' })
  const running = run({ current: evil, rows: hostile.rows, blocked: hostile.blocked, summary: evil, events: [evil] })
  const said = [
    holdLine(hostile).why,
    holdLine(hostile).next,
    holdLine(hostileId).why,
    holdLine(hostileId).next,
    holdLine(view({ ...marks({ 'T-002': 'proposed' }), summary: evil })).why,
    nowLine(running),
    nowLine({ ...running, stage: 'review' }),
    nowLine({ ...running, stage: 'merge', prNumber: 7 }),
    liveLine(hostile),
    liveLine(running),
    statusLine(hostile),
    statusLine(hostile, hackerTheme(DEFAULT_THEME_CAPS)),
    statusLine(hostileId),
  ]
  for (const line of said) expect([line, /SECRET|script|\u001b/.test(line)]).toEqual([line, false])
  expect(nowLine(running)).toBe('Building the item, attempt 2/4')
})

test('buildView feeds the same sentences: a real blocked and proposed plan reads as a cause with its command', () => {
  const items = parseTodo(`## T-001 [feature] First
- status: done
- how: Use the standard library only, because zero dependencies.
- accept: The first thing works for documented inputs.
- tests: Unit tests for each input.

## T-002 [feature] Second
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The second thing works for documented inputs.
- tests: Unit tests for each input.

## T-003 [feature] Third
- status: proposed
- how: Use the standard library only, because zero dependencies.
- accept: The third thing works for documented inputs.
- tests: Unit tests for each input.
`)
  const v = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: false, pausedReason: 'nothing left to do', approvedDone: ['T-001'] }, new Set(['T-002']), null, null)
  expect(holdLine(v)).toEqual({ why: '1 item blocked: T-002', next: '/factory-retry T-002' })
  const p = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: false, pausedReason: 'nothing left to do', approvedDone: ['T-001', 'T-002'] }, new Set(), null, null)
  expect(holdLine(p)).toEqual({ why: '1 item proposed', next: '/factory-approve' })
})

const main = (recent: string[]) => ({ id: 'main', label: 'T-009 (main loop)', kind: 'main', status: 'running', summary: recent.at(-1) ?? '', recent, parent: null })

test('stuckLine stays silent until five minutes without progress, then names the minutes and the pause command', () => {
  expect(STUCK_MS).toBe(300000)
  for (const silentMs of [null, undefined, 0, 4 * 60000 + 59000, Number.NaN, Number.POSITIVE_INFINITY * -1]) expect(stuckLine(run({ silentMs }))).toBe('')
  expect(stuckLine(run({ silentMs: 5 * 60000 }))).toBe('⚠ no progress for 5 min: wait, or /factory-pause')
  expect(stuckLine(run({ silentMs: 5 * 60000 + 59000 }))).toContain('for 5 min')
  expect(stuckLine(run({ silentMs: 12 * 60000 }))).toContain('for 12 min')
  expect(stuckLine(run({ silentMs: 9 * 60000, running: false }))).toBe('')
  expect(stuckLine(run({ silentMs: 5 * 60000 }), hackerTheme(DEFAULT_THEME_CAPS, true))).toBe('! no progress for 5 min: wait, or /factory-pause')
  expect(stuckLine(run({ silentMs: 5 * 60000 }), hackerTheme(DEFAULT_THEME_CAPS))).toBe('▲ no progress for 5 min: wait, or /factory-pause')
})

test('activityLine shows the main loop last action and how long ago, and nothing outside a running factory turn', () => {
  const agents = [main(['Read: a.ts', 'Bash: bun test'])]
  expect(activityLine(run({ silentMs: 0, agents }))).toBe('Last action: Bash: bun test (0s ago)')
  expect(activityLine(run({ silentMs: 4 * 60000 + 59000, agents }))).toBe('Last action: Bash: bun test (4m59s ago)')
  expect(activityLine(run({ silentMs: 5 * 60000, agents }))).toBe('Last action: Bash: bun test (5m00s ago)')
  expect(activityLine(run({ silentMs: null, agents }))).toBe('')
  expect(activityLine(run({ agents }))).toBe('')
  expect(activityLine(run({ silentMs: 3000, agents: [] }))).toBe('')
  expect(activityLine(run({ silentMs: 3000, agents: [main([])] }))).toBe('')
  expect(activityLine(run({ silentMs: 3000, agents: [{ ...main(['x']), id: 'rev1' }] }))).toBe('')
  expect(activityLine(run({ silentMs: 3000, running: false, agents }))).toBe('')
  expect(activityLine(run({ silentMs: 3000, agents: [main([`Bash: ${'x'.repeat(300)}\u001b[2J`])] })).length).toBeLessThan(120)
  expect(activityLine(run({ silentMs: 3000, agents: [main(['Bash: a\u001b[2Jb'])] }))).not.toContain('\u001b')
})

test('statusLine appends the stuck warning only once the five minutes are up, in every look', () => {
  for (const t of [undefined, hackerTheme(DEFAULT_THEME_CAPS), hackerTheme(DEFAULT_THEME_CAPS, true)]) {
    expect(statusLine(run({ silentMs: 4 * 60000 + 59000 }), t)).not.toContain('no progress')
    expect(statusLine(run({ silentMs: null }), t)).not.toContain('no progress')
    expect(statusLine(run({ silentMs: 5 * 60000 }), t)).toContain('no progress for 5 min: wait, or /factory-pause')
  }
  expect(statusLine(run({ silentMs: 5 * 60000, running: false }))).not.toContain('no progress')
})

test('buildView carries silentMs from the caller and null when it is not given', () => {
  const items = parseTodo(`## T-001 [chore] First\n- status: todo\n- how: a\n- accept: b\n- tests: c\n`)
  const state = { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-001' }
  const at = (silentMs?: number | null) => buildView(items, state, new Set(), null, null, undefined, { maxAttempts: 3, maxReviewRounds: 3, agents: [], now: 0, ...(silentMs === undefined ? {} : { silentMs }) }).silentMs
  expect(at(42_000)).toBe(42_000)
  expect(at(null)).toBeNull()
  expect(at()).toBeNull()
})
