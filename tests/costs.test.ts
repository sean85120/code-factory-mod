import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_SETTINGS,
  MAX_COST_ITEMS,
  PLAN_KEY,
  addTokens,
  budgetPauseReason,
  budgetReached,
  costDelta,
  costPhase,
  costsReport,
  decisionsHash,
  emptyRepoCosts,
  liveSpend,
  normalizeRepoCosts,
  noteItem,
  parseCostsArgs,
  parseSettings,
  parseTodo,
  repoKey,
  settleCost,
  startRun,
  treeRun,
} from '../hooks/lib'
import type { RepoCosts } from '../hooks/lib'

const TODO = `## T-001 [chore] First
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The first thing works for documented inputs.
- tests: none needed for a chore.
`
const BASE = { testCmd: ['unit'], baseBranch: 'main' }
const TREE = '/work/widget'
const item = { key: 'T-001', kind: 'item' as const, title: 'First' }
const usage = (model: string, n: number) => ({ input_tokens: n, output_tokens: n * 2, cache_read_input_tokens: n * 3, cache_creation_input_tokens: n * 4, model })

test('the repo key is owner/name for ssh, https and ssh:// remotes, else the folder name', () => {
  expect(repoKey('git@github.com:acme/widget.git\n', '/x/y')).toBe('acme/widget')
  expect(repoKey('https://github.com/acme/widget', '/x/y')).toBe('acme/widget')
  expect(repoKey('https://github.com/acme/widget.git/', '/x/y')).toBe('acme/widget')
  expect(repoKey('ssh://git@host:2222/acme/widget.git', '/x/y')).toBe('acme/widget')
  expect(repoKey('', '/Users/me/code/widget/')).toBe('widget')
  expect(repoKey('', '')).toBe('unknown')
})

test('a cost delta is the growth of the counter, or the whole new value when it went backwards', () => {
  expect(costDelta(1.25, 2)).toBe(0.75)
  expect(costDelta(5, 0.4)).toBe(0.4)
  expect(costDelta(1, Number.NaN)).toBe(0)
  expect(costDelta(1, -3)).toBe(0)
})

test('settling charges the marked item, the run and the repo, then re-marks or clears', () => {
  let rc = startRun(emptyRepoCosts('acme/widget'), 0, TREE)
  rc = settleCost(rc, { tree: TREE, from: 's1', to: 's1', nowUsd: 1, now: 1000, next: item }).costs
  expect(rc.marks.s1).toEqual({ ...item, usd: 1, at: 1000, tree: TREE })
  const kept = settleCost(rc, { tree: TREE, from: 's1', to: 's1', nowUsd: 1.5, now: 61000, next: 'keep' })
  expect(kept.delta).toBe(0.5)
  expect(kept.costs.items['T-001']!.usd).toBe(0.5)
  expect(kept.costs.items['T-001']!.ms).toBe(60000)
  expect(kept.costs.runs[0]!.usd).toBe(0.5)
  expect(kept.costs.usd).toBe(0.5)
  expect(kept.costs.marks.s1!.usd).toBe(1.5)
  const cleared = settleCost(kept.costs, { tree: TREE, from: 's1', to: 's1', nowUsd: 2.5, now: 62000, next: null }).costs
  expect(cleared.items['T-001']!.usd).toBe(1.5)
  expect(cleared.marks.s1).toBeUndefined()
  const idle = settleCost(cleared, { tree: TREE, from: 's1', to: 's1', nowUsd: 9, now: 63000, next: null })
  expect(idle.delta).toBe(0)
  expect(idle.costs.items['T-001']!.usd).toBe(1.5)
})

test('a counter that restarted is charged from zero, and the mark moves to the new session id', () => {
  let rc = startRun(emptyRepoCosts('r'), 0, TREE)
  rc = settleCost(rc, { tree: TREE, from: 'old', to: 'old', nowUsd: 7, now: 0, next: item }).costs
  const r = settleCost(rc, { tree: TREE, from: 'old', to: 'new', nowUsd: 0.3, now: 10, next: 'keep' })
  expect(r.delta).toBe(0.3)
  expect(r.costs.marks.old).toBeUndefined()
  expect(r.costs.marks.new!.usd).toBe(0.3)
})

test("another session's mark is never touched, and design spend stays out of the run", () => {
  let rc = startRun(emptyRepoCosts('r'), 0, TREE)
  rc = settleCost(rc, { tree: TREE, from: 'b', to: 'b', nowUsd: 4, now: 0, next: { key: PLAN_KEY, kind: 'design', title: 'design interview' } }).costs
  rc = settleCost(rc, { tree: TREE, from: 'a', to: 'a', nowUsd: 1, now: 0, next: item }).costs
  rc = settleCost(rc, { tree: TREE, from: 'a', to: 'a', nowUsd: 2, now: 5, next: null }).costs
  expect(rc.marks.b!.usd).toBe(4)
  rc = settleCost(rc, { tree: TREE, from: 'b', to: 'b', nowUsd: 6, now: 9, next: null }).costs
  expect(rc.items[PLAN_KEY]!.usd).toBe(2)
  expect(rc.runs[0]!.usd).toBe(1)
  expect(rc.usd).toBe(3)
})

test('tokens are summed per model and per phase; reviewer turns are review, CI fixes are ci-fix', () => {
  let rc = emptyRepoCosts('r')
  rc = addTokens(rc, 'T-001', 'First', costPhase('item', 'build', false), usage('claude-opus-4-1', 10), 0)
  rc = addTokens(rc, 'T-001', 'First', costPhase('item', 'build', true), usage('claude-sonnet-4-5', 1), 0)
  rc = addTokens(rc, 'T-001', 'First', costPhase('item', 'CI', false), usage('claude-opus-4-1', 1), 0)
  const it = rc.items['T-001']!
  expect(it.models['claude-opus-4-1']).toEqual([11, 22, 33, 44])
  expect(it.models['claude-sonnet-4-5']).toEqual([1, 2, 3, 4])
  expect(it.phases).toEqual({ build: 100, review: 10, 'ci-fix': 10 })
  expect(costPhase('item', 'merge', false)).toBe('ci-fix')
  expect(costPhase('item', 'PR', false)).toBe('build')
  expect(costPhase('roadmap', 'CI', false)).toBe('roadmap')
})

test('live spend adds the unsettled part of my own mark', () => {
  let rc = startRun(emptyRepoCosts('r'), 0, TREE)
  rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: 1, now: 0, next: item }).costs
  rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: 2, now: 1, next: 'keep' }).costs
  expect(liveSpend(rc, 's', TREE, 2.5, 'T-001')).toEqual({ runUsd: 1.5, itemUsd: 1.5 })
  expect(liveSpend(rc, 'other', TREE, 2.5, 'T-001')).toEqual({ runUsd: 1, itemUsd: 1 })
  expect(liveSpend(rc, 's', TREE, null, null)).toEqual({ runUsd: 1, itemUsd: 0 })
})

test('the budget is reached at the limit, never when it is 0', () => {
  expect(budgetReached(5, 5)).toBe(true)
  expect(budgetReached(5, 4.99)).toBe(false)
  expect(budgetReached(0, 1000)).toBe(false)
  expect(budgetPauseReason(5, 5.2)).toContain('$5.20 of the $5.00 budget')
})

test('budgetUsd and askNextPhase parse, are validated, and keep old approvals valid at their defaults', () => {
  const items = parseTodo(TODO)
  const plain = parseSettings(JSON.stringify(BASE))
  expect(plain.settings.budgetUsd).toBe(0)
  expect(plain.settings.askNextPhase).toBe(true)
  expect(decisionsHash(plain.settings, items)).toBe('5537cbad')
  expect(decisionsHash(parseSettings(JSON.stringify({ ...BASE, budgetUsd: 0, askNextPhase: true })).settings, items)).toBe('5537cbad')
  const budget = parseSettings(JSON.stringify({ ...BASE, budgetUsd: 12.5 }))
  expect(budget.settings.budgetUsd).toBe(12.5)
  expect(decisionsHash(budget.settings, items)).not.toBe('5537cbad')
  expect(decisionsHash(parseSettings(JSON.stringify({ ...BASE, askNextPhase: false })).settings, items)).not.toBe('5537cbad')
  expect(parseSettings(JSON.stringify({ ...BASE, budgetUsd: -1 })).problems.join()).toContain('budgetUsd')
  expect(parseSettings(JSON.stringify({ ...BASE, budgetUsd: 'ten' })).problems.join()).toContain('budgetUsd')
  expect(DEFAULT_SETTINGS.budgetUsd).toBe(0)
})

test('a damaged ledger is read back as an empty one, never a crash', () => {
  expect(normalizeRepoCosts(null, 'r')).toEqual(emptyRepoCosts('r'))
  expect(normalizeRepoCosts('junk', 'r').items).toEqual({})
  const odd = normalizeRepoCosts({ usd: 'x', items: { 'T-1': { usd: 2, models: { m: [1, 'a'] } } }, runs: [{ usd: 1 }, 3], marks: { s: { key: 'T-1', kind: 'bogus' } } }, 'r')
  expect(odd.usd).toBe(0)
  expect(odd.items['T-1']!.usd).toBe(2)
  expect(odd.items['T-1']!.models.m).toEqual([1, 0, 0, 0])
  expect(odd.runs).toEqual([{ startedAt: 0, lastAt: 0, usd: 1, items: 0, tree: '' }])
  expect(odd.marks).toEqual({})
})

test('the ledger stays bounded: old items, runs and stale marks are dropped', () => {
  let rc: RepoCosts = emptyRepoCosts('r')
  for (let i = 0; i < MAX_COST_ITEMS + 5; i++) rc.items[`T-${i}`] = { title: '', usd: 0, models: {}, phases: {}, attempts: 0, ms: 0, firstAt: i, lastAt: i, outcome: '' }
  for (let i = 0; i < 30; i++) rc = startRun(rc, i, TREE)
  rc.marks.stale = { ...item, usd: 0, at: 0, tree: TREE }
  rc = noteItem(rc, 'T-999', 'x', 3 * 86400000, { attempt: true })
  expect(Object.keys(rc.items).length).toBe(MAX_COST_ITEMS)
  expect(rc.items['T-0']).toBeUndefined()
  expect(rc.items['T-999']!.attempts).toBe(1)
  expect(rc.runs.length).toBe(20)
  expect(rc.marks.stale).toBeUndefined()
})

function ledger(repo: string, rows: Record<string, number>): RepoCosts {
  let rc = startRun(emptyRepoCosts(repo), 0, TREE)
  for (const [id, usd] of Object.entries(rows)) {
    rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: 0, now: 0, next: { key: id, kind: 'item', title: `${id} title` } }).costs
    rc = addTokens(rc, id, '', 'build', usage('claude-opus-4-1', 1000), 0)
    rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: usd, now: 120000, next: null }).costs
  }
  return rc
}

test('the costs report sorts repos by spend and tables the selected repo by item', () => {
  const a = ledger('acme/small', { 'T-001': 1 })
  const b = ledger('acme/big', { 'T-001': 3, 'T-002': 1 })
  const text = costsReport([a, b], '', 'acme/big')
  expect(text).toContain('all repos: $5.00')
  expect(text).toContain('advisory only, the ledger file is not protected from the model')
  expect(text.indexOf('acme/big')).toBeLessThan(text.indexOf('acme/small'))
  expect(text).toContain('acme/big (this repo): $4.00 over 2 item(s)')
  expect(text).toMatch(/T-001\s+\$3\.00\s+75%/)
  expect(text).toContain('opus-4-1 10k (out 2.0k)')
  expect(text).toContain('build 100%')
  expect(text).toContain('most expensive: T-001 $3.00 (75%)')
  expect(text).not.toContain('acme/small (this repo)')
  expect(costsReport([a, b], 'small', 'acme/big')).toContain('acme/small: $1.00 over 1 item(s)')
  const all = costsReport([a, b], 'all', null)
  expect(all).toContain('acme/small: $1.00')
  expect(all).toContain('acme/big: $4.00')
  expect(costsReport([a, b], 'nope', 'acme/big')).toContain('No recorded repo matches "nope"')
  expect(costsReport([], '', null)).toContain('No factory costs recorded yet')
})

test('costs arguments: a filter, or reset with the repo key', () => {
  expect(parseCostsArgs('')).toEqual({ reset: null, filter: '' })
  expect(parseCostsArgs(' all ')).toEqual({ reset: null, filter: 'all' })
  expect(parseCostsArgs('reset acme/big')).toEqual({ reset: 'acme/big', filter: '' })
  expect(parseCostsArgs('reset')).toEqual({ reset: '', filter: '' })
})

test('an unreadable counter never opens a dollar baseline, so a later reading is not charged in full', () => {
  let rc = startRun(emptyRepoCosts('r'), 0, TREE)
  rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: null, now: 0, next: item }).costs
  expect(rc.marks.s!.usd).toBeNull()
  const first = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: 30, now: 10, next: 'keep' })
  expect(first.delta).toBe(0)
  expect(first.costs.marks.s!.usd).toBe(30)
  const second = settleCost(first.costs, { tree: TREE, from: 's', to: 's', nowUsd: 31, now: 20, next: 'keep' })
  expect(second.delta).toBe(1)
  const kept = settleCost(second.costs, { tree: TREE, from: 's', to: 's', nowUsd: null, now: 30, next: 'keep' })
  expect(kept.costs.marks.s!.usd).toBe(31)
  expect(liveSpend(kept.costs, 's', TREE, 32, 'T-001').runUsd).toBe(2)
})

test('a ledger without a run still accrues run spend, so the budget cannot be switched off', () => {
  let rc = emptyRepoCosts('r')
  rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: 1, now: 0, next: item }).costs
  rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: 4, now: 10, next: 'keep' }).costs
  expect(rc.runs.length).toBe(1)
  expect(rc.runs[0]!.usd).toBe(3)
  expect(budgetReached(2, liveSpend(rc, 's', TREE, 4, 'T-001').runUsd)).toBe(true)
  expect(liveSpend(emptyRepoCosts('r'), 's', TREE, 4, null).runUsd).toBe(0)
})

test('a null reading never discards a numeric baseline: the mark stays until a real reading charges the whole span', () => {
  let rc = startRun(emptyRepoCosts('r'), 0, TREE)
  rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: 1, now: 0, next: item }).costs
  const next = { key: 'T-002', kind: 'item' as const, title: 'Second' }
  const driven = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: null, now: 10, next })
  expect(driven.delta).toBe(0)
  expect(driven.costs.marks.s).toEqual({ ...item, usd: 1, at: 0, tree: TREE })
  const closed = settleCost(driven.costs, { tree: TREE, from: 's', to: 's', nowUsd: null, now: 20, next: null })
  expect(closed.costs.marks.s).toEqual({ ...item, usd: 1, at: 0, tree: TREE })
  expect(liveSpend(closed.costs, 's', TREE, 5, 'T-001').runUsd).toBe(4)
  const later = settleCost(closed.costs, { tree: TREE, from: 's', to: 's', nowUsd: 5, now: 30, next: null })
  expect(later.delta).toBe(4)
  expect(later.costs.runs[0]!.usd).toBe(4)
  expect(later.costs.marks.s).toBeUndefined()
})

test('a null reading over an unknown baseline still moves the mark to the next drive', () => {
  let rc = startRun(emptyRepoCosts('r'), 0, TREE)
  rc = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: null, now: 0, next: item }).costs
  const next = { key: 'T-002', kind: 'item' as const, title: 'Second' }
  const moved = settleCost(rc, { tree: TREE, from: 's', to: 's', nowUsd: null, now: 10, next }).costs
  expect(moved.marks.s).toEqual({ ...next, usd: null, at: 10, tree: TREE })
})

test('two working trees of one repo keep their own runs: a start in one never resets the other, spend is charged to its own tree, totals sum both', () => {
  const A = '/work/a'
  const B = '/work/b'
  const second = { key: 'T-002', kind: 'item' as const, title: 'Second' }
  let rc = startRun(emptyRepoCosts('acme/widget'), 0, A)
  rc = settleCost(rc, { tree: A, from: 'sa', to: 'sa', nowUsd: 0, now: 0, next: item }).costs
  rc = settleCost(rc, { tree: A, from: 'sa', to: 'sa', nowUsd: 4.5, now: 10, next: 'keep' }).costs
  rc = startRun(rc, 20, B)
  expect(liveSpend(rc, 'sa', A, 4.5, 'T-001').runUsd).toBe(4.5)
  expect(liveSpend(rc, 'sb', B, null, null).runUsd).toBe(0)
  rc = settleCost(rc, { tree: B, from: 'sb', to: 'sb', nowUsd: 0, now: 30, next: second }).costs
  rc = settleCost(rc, { tree: B, from: 'sb', to: 'sb', nowUsd: 3, now: 40, next: 'keep' }).costs
  expect(liveSpend(rc, 'sa', A, 4.5, 'T-001').runUsd).toBe(4.5)
  expect(liveSpend(rc, 'sb', B, 3, 'T-002').runUsd).toBe(3)
  expect(budgetReached(5, liveSpend(rc, 'sa', A, 5.25, 'T-001').runUsd)).toBe(true)
  expect(budgetReached(5, liveSpend(rc, 'sb', B, 3, 'T-002').runUsd)).toBe(false)
  rc = settleCost(rc, { tree: A, from: 'sa', to: 'sa', nowUsd: 5.25, now: 50, next: null }).costs
  expect(treeRun(rc, A)!.usd).toBe(5.25)
  expect(treeRun(rc, B)!.usd).toBe(3)
  rc = noteItem(rc, 'T-001', 'First', 60, { outcome: 'merged', runItemTree: A })
  expect(treeRun(rc, A)!.items).toBe(1)
  expect(treeRun(rc, B)!.items).toBe(0)
  expect(rc.usd).toBe(8.25)
  expect(costsReport([rc], '', 'acme/widget')).toContain('acme/widget (this repo): $8.25')
  for (let i = 0; i < 30; i++) rc = startRun(rc, 100 + i, B)
  expect(treeRun(rc, A)!.usd).toBe(5.25)
  expect(rc.runs.length).toBe(21)
})

test('a legacy ledger without tree tags still loads, is summed in totals, and counts against no tree budget', () => {
  const raw = { repo: 'acme/widget', usd: 7, items: { 'T-001': { title: 'First', usd: 7, models: {}, phases: {}, attempts: 1 } }, runs: [{ startedAt: 0, lastAt: 5, usd: 7, items: 1 }], marks: { old: { key: 'T-001', kind: 'item', title: 'First', usd: 1, at: 0 } } }
  let rc = normalizeRepoCosts(raw, 'acme/widget')
  expect(rc.runs).toEqual([{ startedAt: 0, lastAt: 5, usd: 7, items: 1, tree: '' }])
  expect(rc.marks.old!.tree).toBe('')
  expect(liveSpend(rc, 'sa', TREE, null, null).runUsd).toBe(0)
  expect(liveSpend(rc, 'sa', '', null, null).runUsd).toBe(0)
  expect(costsReport([rc], '', 'acme/widget')).toContain('$7.00')
  rc = settleCost(rc, { tree: TREE, from: 'old', to: 'old', nowUsd: 2, now: 10, next: null }).costs
  expect(treeRun(rc, TREE)!.usd).toBe(1)
  expect(rc.runs[0]!.usd).toBe(7)
  expect(rc.usd).toBe(8)
})

test("another tree's latest run survives a JSON round trip through normalizeRepoCosts after many runs elsewhere", () => {
  const A = '/work/a'
  const B = '/work/b'
  let rc = startRun(emptyRepoCosts('r'), 0, A)
  rc = settleCost(rc, { from: 'o', to: 'o', tree: A, nowUsd: 0, now: 1, next: item }).costs
  rc = settleCost(rc, { from: 'o', to: 'o', tree: A, nowUsd: 9, now: 2, next: null }).costs
  expect(treeRun(rc, A)!.usd).toBe(9)
  for (let i = 0; i < 25; i++) {
    rc = startRun(rc, 10 + i, B)
    rc = normalizeRepoCosts(JSON.parse(JSON.stringify(rc)), 'r')
  }
  expect(treeRun(rc, A)?.usd).toBe(9)
  expect(rc.runs.filter(r => r.tree === B).length).toBe(20)
  expect(rc.runs.length).toBe(21)
})

test('legacy untagged runs are still capped to the last 20 when loaded', () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({ startedAt: i, lastAt: i, usd: i, items: 0 }))
  const rc = normalizeRepoCosts(JSON.parse(JSON.stringify({ repo: 'r', usd: 0, items: {}, runs, marks: {} })), 'r')
  expect(rc.runs.length).toBe(20)
  expect(rc.runs.map(r => r.startedAt)).toEqual(Array.from({ length: 20 }, (_, i) => i + 10))
  expect(rc.runs.every(r => r.tree === '')).toBe(true)
})
