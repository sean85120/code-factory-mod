import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_STATE,
  MAX_EVENTS,
  appendEvent,
  cleanText,
  costsReport,
  normalizeRepoCosts,
  safeLines,
  buildView,
  ciOutcome,
  commitMessage,
  designPushSteps,
  isSafeBranchName,
  isRoadmapDone,
  formatLog,
  mergeEvents,
  nextItemId,
  parseItemArg,
  parsePrUrl,
  parseSettings,
  parseTodo,
  planComplete,
  roadmapPrompt,
  sanitizeEvents,
  shouldAskRoadmap,
  statusReport,
  stripControls,
} from '../hooks/lib'
import type { FactoryEvent } from '../hooks/lib'

const TODO = `## T-001 [feature] First
- status: done
- how: Use the standard library only, because zero dependencies.
- accept: The first thing works for documented inputs.
- tests: Unit tests for each input.

## T-002 [bug] Second
- status: todo
- version: 0.2
- how: Use the standard library only, because zero dependencies.
- accept: The second thing works for documented inputs.
- tests: Unit tests for each input.

## T-003 [chore] Third
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The third thing works for documented inputs.
- tests: Unit tests for each input.
`
const settings = parseSettings(JSON.stringify({ testCmd: ['unit'], budgetUsd: 10 })).settings
const ev = (ts: number, kind: FactoryEvent['kind'], itemId: string | null = 'T-002', detail = ''): FactoryEvent => ({ ts, kind, itemId, detail })

test('events append in order, repeats in a row are dropped, and the list is capped', () => {
  let list: FactoryEvent[] = []
  list = appendEvent(list, ev(1, 'ci-failed', 'T-002', 'gh pr checks: failing'))
  list = appendEvent(list, ev(2, 'ci-failed', 'T-002', 'gh pr checks: failing'))
  list = appendEvent(list, ev(3, 'commit', 'T-002', 'fix\n  the   thing'))
  expect(list.map(e => e.kind)).toEqual(['ci-failed', 'commit'])
  expect(list[1]!.detail).toBe('fix the thing')
  for (let i = 0; i < MAX_EVENTS + 10; i++) list = appendEvent(list, ev(10 + i, 'nudge', 'T-002', `n${i}`))
  expect(list.length).toBe(MAX_EVENTS)
  expect(list[list.length - 1]!.detail).toBe(`n${MAX_EVENTS + 9}`)
})

test('merging keeps events written by either side, ordered by time, without duplicates', () => {
  const disk = [ev(1, 'started'), ev(5, 'commit')]
  const stale = [ev(1, 'started'), ev(3, 'nudge')]
  expect(mergeEvents(disk, stale).map(e => `${e.ts}:${e.kind}`)).toEqual(['1:started', '3:nudge', '5:commit'])
})

test('a hand-edited event list is cleaned on read', () => {
  expect(sanitizeEvents('x')).toEqual([])
  expect(sanitizeEvents([{ ts: 1, kind: 'bogus' }, { ts: 2, kind: 'commit', itemId: 3, detail: 'm' }, null])).toEqual([{ ts: 2, kind: 'commit', itemId: null, detail: 'm' }])
})

test('the log lists one item or all, newest last, with the gaps between events', () => {
  const list = [ev(0, 'started', 'T-002', 'Second'), ev(90_000, 'commit', 'T-002', 'T-002: fix'), ev(100_000, 'started', 'T-003'), { ...ev(3_790_000, 'pr-opened'), pr: 12, url: 'https://github.com/o/r/pull/12' }]
  const one = formatLog(list, 't-002')
  expect(one).toContain('for T-002 (3 events, 1h03m from first to last')
  expect(one).toContain('+1m30s')
  expect(one).toContain('#12 https://github.com/o/r/pull/12')
  expect(one).not.toContain('T-003')
  expect(one.indexOf('started')).toBeLessThan(one.indexOf('pr-opened'))
  expect(formatLog(list, null)).toContain('T-003')
  expect(formatLog([], 'T-009')).toBe('No events recorded for T-009.')
})

test('commit messages, PR links, CI outcomes and item arguments are read from text', () => {
  expect(commitMessage('git add -A && git commit -m "T-002: fix the bug" -- a.ts')).toBe('T-002: fix the bug')
  expect(commitMessage('git commit --message=wip')).toBe('wip')
  expect(commitMessage('git commit')).toBe('commit')
  expect(parsePrUrl('Creating pull request\nhttps://github.com/o/r/pull/42\n')).toEqual({ pr: 42, url: 'https://github.com/o/r/pull/42' })
  expect(parsePrUrl('no link')).toBeNull()
  expect(ciOutcome('build\tfail\t2m\thttps://x')).toBe('failed')
  expect(ciOutcome('All checks were successful\n0 cancelled, 0 failing, 2 successful, 0 skipped, and 0 pending checks')).toBe('passed')
  expect(ciOutcome('build\tpending\t0\nlint\tpass\t1m')).toBeNull()
  expect(ciOutcome('build\tpass\t1m')).toBe('passed')
  expect(parseItemArg(' t-004  needs a  product call ')).toEqual({ id: 'T-004', note: 'needs a product call' })
  expect(parseItemArg('nonsense')).toEqual({ id: null, note: '' })
  for (const hostile of ['../x', '--help', 'T-001/../..', '', 'T-001;rm', 'T-001\u0000x', `T-${'9'.repeat(7)}`, `${'A'.repeat(11)}-1`, `T-001 ${'x'.repeat(3000)}`]) {
    expect(parseItemArg(hostile).id).toBeNull()
  }
})

test('status shows the current item in detail, spend against the budget, the queue and blocked reasons', () => {
  const items = parseTodo(TODO)
  const state = {
    ...DEFAULT_STATE,
    approved: true,
    autopilot: true,
    current: 'T-002',
    attempts: 1,
    reviewRounds: 2,
    doneThisRun: 1,
    events: [ev(1_000, 'started', 'T-002', 'Second'), { ...ev(2_000, 'pr-opened'), pr: 7, url: 'https://github.com/o/r/pull/7' }],
  }
  const text = statusReport({ state, settings, items, blocked: new Map([['T-003', 'Skipped by you: waiting on design']]), stage: 'CI', now: 601_000, runUsd: 2.5, itemUsd: 1.25 })
  expect(text).toContain('Factory: running')
  expect(text).toContain('Current: T-002 [bug] Second: stage CI, attempt 2/5, review round 2/5, PR #7 https://github.com/o/r/pull/7, 10m00s elapsed, $1.25 spent')
  expect(text).toContain('This run: $2.50 of the $10.00 budget, 1 item(s) merged')
  expect(text).toContain('Queue: (empty)')
  expect(text).toContain('- T-003: Skipped by you: waiting on design')
  expect(text).toContain('Recent: T-002 started · T-002 PR #7')
  expect(text).toContain('- T-001 [feature] done: First')
  const unmetered = statusReport({ state: { ...DEFAULT_STATE, approved: true }, settings, items, blocked: new Map(), stage: null, now: 0, runUsd: null, itemUsd: null })
  expect(unmetered).toContain('spend cannot be read')
  expect(unmetered).toContain('$10.00 budget cannot be enforced')
  const idle = statusReport({ state: { ...DEFAULT_STATE, approved: true, pausedReason: 'stopped by you' }, settings: { ...settings, budgetUsd: 0 }, items, blocked: new Map(), stage: null, now: 0, runUsd: null, itemUsd: null })
  expect(idle).toContain('paused (stopped by you)')
  expect(idle).toContain('Queue: T-002, T-003')
  expect(idle).not.toContain('This run')
  expect(idle).not.toContain('Current:')
})

test('the band carries run and item spend and the last timeline events', () => {
  const items = parseTodo(TODO)
  const state = { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-002', events: [ev(1, 'started'), ev(2, 'commit'), { ...ev(3, 'pr-opened'), pr: 9 }, ev(4, 'ci-passed')] }
  const v = buildView(items, state, new Set(), null, null, { runUsd: 3, itemUsd: 1, budgetUsd: 10 })
  expect(v.runUsd).toBe(3)
  expect(v.itemUsd).toBe(1)
  expect(v.budgetUsd).toBe(10)
  expect(v.events).toEqual(['T-002 commit', 'T-002 PR #9', 'T-002 CI ✓'])
  const idle = buildView(items, { ...state, current: null }, new Set(), null, null, { runUsd: 3, itemUsd: 1, budgetUsd: 0 })
  expect(idle.itemUsd).toBeNull()
  expect(buildView(items, state, new Set(), null, null).runUsd).toBeNull()
})

test('the next phase is asked once, only for an approved plan that is completely done', () => {
  const items = parseTodo(TODO)
  const done = items.map(i => ({ ...i, status: 'done' as const }))
  const approved = { approved: true, roadmapAsked: false }
  expect(planComplete(done)).toBe(true)
  expect(planComplete(items)).toBe(false)
  expect(planComplete([])).toBe(false)
  expect(shouldAskRoadmap(settings, approved, done)).toBe(true)
  expect(shouldAskRoadmap(settings, { ...approved, roadmapAsked: true }, done)).toBe(false)
  expect(shouldAskRoadmap(settings, { ...approved, approved: false }, done)).toBe(false)
  expect(shouldAskRoadmap({ askNextPhase: false }, approved, done)).toBe(false)
  expect(shouldAskRoadmap(settings, approved, [...done.slice(1), { ...done[0]!, status: 'proposed' }])).toBe(false)
})

test('new ids continue the numbering', () => {
  expect(nextItemId(parseTodo(TODO))).toBe('T-004')
  expect(nextItemId([])).toBe('T-001')
  expect(nextItemId(parseTodo(TODO.replace('T-003', 'T-0120')))).toBe('T-0121')
})

test('the roadmap prompt summarizes what shipped and its cost, interviews, and never builds', () => {
  const items = parseTodo(TODO).map(i => ({ ...i, status: 'done' as const }))
  const p = roadmapPrompt(items, ['T-002'], 'Total recorded for o/r: $4.00.\n- T-002 Second: $3.00', settings)
  expect(p).toContain('NEXT-PHASE INTERVIEW')
  expect(p).toContain('- T-002 [bug] v0.2 Second (PR merged by the factory)')
  expect(p).toContain('$3.00')
  expect(p).toContain('AskUserQuestion')
  expect(p).toContain('WHICH VERSION THE LOOP MUST STOP AFTER')
  expect(p).toContain('HOW decision')
  expect(p).toContain('nothing more, stop here')
  expect(p).toContain('write nothing')
  expect(p).toContain('the next id is T-004')
  expect(p).toContain('- status: proposed')
  expect(p).toContain('ask the person to confirm')
  expect(p).toContain('Do not commit, push, stage, branch or open a PR')
  expect(p).toContain('telling the person to commit and push the three design files to the base branch themselves')
  expect(p).toContain(designPushSteps('main'))
  expect(p).toContain(`\n  git checkout 'main' && git add -- ${PATHS} && git commit -m "Code factory design" -- ${PATHS} && git push origin 'main'\n`)
  expect(p).toContain('/factory-start after /factory-approve passes')
  expect(p).toContain('do not run any of them yourself')
  expect(p).not.toContain('itself commits and pushes')
  expect(p).toContain('do not start implementing')
  expect(p).toContain('End the FINAL message of this interview with a last line containing only ROADMAP-DONE')
  expect(p).toContain('nothing more, stop here". Never put that line in an earlier message.')
})


const PATHS = '.factory/design.md .factory/todo.md .factory/settings.json'
const PUSH_ONLY = "git checkout 'main' && git push origin 'main'"
const commandLines = (t: string): string[] => t.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

const HOSTILE = ['main; touch ~/pwn', '$(x)', 'a`id`b', 'a b', '-x', 'a..b', '', "it's", 'x\ny', 'a"b', 'a\\b', 'a~1', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', '/a', '.a', 'a/', 'a.', 'a.lock', 'a@{1}', '@', 'a//b', 'a\tb', 'x'.repeat(201)]

test('branch names: plain names pass, shell-active or git-invalid ones are rejected, also by parseSettings', () => {
  for (const ok of ['main', 'release/1.0', 'dev_2', 'feature/a-b', 'release+x', 'foo@bar', 'feature/a,b', 'a;b', 'x(1)', 'feature/é', 'zh/功能']) {
    expect(isSafeBranchName(ok)).toBe(true)
    expect(parseSettings(JSON.stringify({ testCmd: ['t'], baseBranch: ok })).problems).toEqual([])
  }
  for (const bad of HOSTILE) {
    expect(isSafeBranchName(bad)).toBe(false)
    if (bad.trim()) expect(parseSettings(JSON.stringify({ testCmd: ['t'], baseBranch: bad })).problems.join(' ')).toContain('not a plain branch name')
  }
})

test('push steps and the roadmap prompt print no runnable line for an unsafe base branch', () => {
  for (const bad of HOSTILE) {
    const steps = designPushSteps(bad, 'feature/x')
    expect(steps).toContain('no git commands are shown')
    expect(steps).not.toMatch(/^\s*git /m)
    const p = roadmapPrompt(parseTodo(TODO), [], '', { ...settings, baseBranch: bad })
    expect(p).not.toMatch(/^\s*git /m)
    expect(p).toContain('no git commands are shown')
  }
})

test('push steps from a feature branch check out the base, copy the files over, and push the base', () => {
  const steps = designPushSteps('main', 'factory/t-001-x')
  expect(commandLines(steps)).toEqual([
    `git checkout 'main' && git checkout 'factory/t-001-x' -- ${PATHS} && git add -- ${PATHS} && git commit -m "Code factory design" -- ${PATHS} && git push origin 'main'`,
    `git checkout 'main' && git add -- ${PATHS} && git commit -m "Code factory design" -- ${PATHS} && git push origin 'main'`,
    PUSH_ONLY,
  ])
  expect(steps).not.toContain('HEAD:')
  const unsafeCurrent = designPushSteps('main', 'bad name')
  expect(unsafeCurrent).not.toContain('<feature-branch>')
  expect(unsafeCurrent).not.toContain('bad name')
  expect(unsafeCurrent).toContain('copy them over to the base branch by hand')
  expect(commandLines(unsafeCurrent)).toEqual([`git checkout 'main' && git add -- ${PATHS} && git commit -m "Code factory design" -- ${PATHS} && git push origin 'main'`, PUSH_ONLY])
  expect(commandLines(designPushSteps('main', 'main'))).toEqual([`git checkout 'main' && git add -- ${PATHS} && git commit -m "Code factory design" -- ${PATHS} && git push origin 'main'`, PUSH_ONLY])
  expect(designPushSteps('main', null)).not.toContain('<feature-branch>')
})

test('accepted unusual base branch names are printed single-quoted in the push steps', () => {
  for (const name of ['release+x', 'foo@bar', 'feature/a,b']) {
    const steps = designPushSteps(name, null)
    expect(steps).toContain(`  git checkout '${name}' && `)
    expect(steps).toContain(` && git push origin '${name}'`)
  }
})

test('every printed push step is a complete command: comments start with #, no unquoted parenthesis, and the push only runs after the earlier steps succeed', () => {
  for (const [base, cur] of [['main', null], ['main', 'feature/x'], ['main', 'bad name'], ['x(1)', 'y(2)'], ['release+x', null]] as const) {
    const steps = designPushSteps(base, cur)
    const lines = steps.split('\n').map(l => l.trim()).filter(Boolean)
    for (const l of lines) {
      if (l.startsWith('#')) continue
      expect(l.startsWith('git ')).toBe(true)
      expect(/[()]/.test(l.replace(/'[^']*'|"[^"]*"/g, ''))).toBe(false)
      expect(l).toMatch(/ && git push origin '[^']+'$/)
      const steps = l.split(' && ')
      expect(steps[0]).toBe(`git checkout '${base}'`)
      if (steps.length === 2) expect(l).toBe(`git checkout '${base}' && git push origin '${base}'`)
      else expect(steps.slice(-3).map(x => x.split(' ').slice(0, 2).join(' '))).toEqual(['git add', 'git commit', 'git push'])
    }
    const commands = lines.filter(l => !l.startsWith('#'))
    expect(commands.length).toBe(cur && isSafeBranchName(cur) ? 3 : 2)
    expect(commands[commands.length - 1]).toBe(`git checkout '${base}' && git push origin '${base}'`)
    const pushOnlyAt = lines.indexOf(`git checkout '${base}' && git push origin '${base}'`)
    expect(lines[pushOnlyAt - 1]).toBe('# If the design files are already committed on the base branch but not pushed, run only this line:')
  }
})

const CONTROL = ['\x1b', '\x00', '\x07', '\x7f', '\x80', '\x9b', '\x9f', '\u200b', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069', '\u00ad', '\u061c', '\u180e', '\u2060', '\u2061', '\u2064', '\ufeff', '\u{E0001}', '\u{E0041}', '\u{E007F}']

test('control, C1, zero-width and bidi characters are rejected in branch names and never printed in runnable lines', () => {
  for (const c of CONTROL) {
    const bad = `main${c}x`
    expect(isSafeBranchName(bad)).toBe(false)
    expect(parseSettings(JSON.stringify({ testCmd: ['t'], baseBranch: bad })).problems.join(' ')).toContain('not a plain branch name')
    const steps = designPushSteps(bad, null)
    expect(steps).not.toMatch(/^\s*git /m)
    const fromFeature = designPushSteps('main', `feature/${c}x`)
    expect(fromFeature).not.toContain('<feature-branch>')
    expect(fromFeature).toContain('copy them over to the base branch by hand')
    for (const line of fromFeature.split('\n')) expect(line.includes(c)).toBe(false)
    const p = roadmapPrompt(parseTodo(TODO), [], '', { ...settings, baseBranch: bad })
    expect(p).not.toMatch(/^\s*git /m)
  }
})

const EVIL_BITS = ['\x1b]8;;http://evil\x07click\x1b]8;;\x07', '\x1b[2K', '\x1b[2J', '\x00', '\x9b31m', '‮', '⁦', '⁩', '​', '‏', '­', '؜', '᠎', '⁠', '\x7f', '\x85', '\x07', '﻿']
const EVIL = `ok${EVIL_BITS.join('')}end`
const DIRTY = /[\x00-\x09\x0b-\x1f\x7f-\x9f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/
const isClean = (t: string): boolean => !DIRTY.test(t)
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
const dirtyEvents = (): FactoryEvent[] => [
  { ts: 1000, itemId: 'T-002', kind: 'commit', detail: EVIL },
  { ts: 2000, itemId: 'T-002', kind: 'pr-opened', detail: EVIL, pr: 7, url: `https://github.com/o/r/pull/7${EVIL}` },
  { ts: 3000, itemId: 'T-002', kind: 'review-verdict', detail: `danger=0 ${EVIL}` },
]

test('stripControls removes C0, DEL, C1, zero-width and bidi controls and keeps ordinary text', () => {
  const out = stripControls(`a\tb\nc${EVIL} é 功`)
  expect(isClean(out)).toBe(true)
  expect(out).toContain('a b c')
  expect(out).toContain('click')
  expect(out).toContain('é 功')
  expect(cleanText(`  x\x1b[2K \n‮ y  `)).toBe('x[2K y')
})

test('events are cleaned when stored and when loaded from disk', () => {
  const stored = appendEvent([], { ts: 1, itemId: 'T-001', kind: 'pr-opened', detail: EVIL, pr: 1, url: `https://x/pull/1${EVIL}` })[0]!
  expect(isClean(stored.detail)).toBe(true)
  expect(isClean(stored.url!)).toBe(true)
  for (const e of sanitizeEvents(dirtyEvents().map(e => ({ ...e, itemId: `T-002${EVIL}` })))) {
    expect(strings(e).every(isClean)).toBe(true)
  }
})

test('/factory-log output carries no terminal control characters even from raw events', () => {
  const log = formatLog(dirtyEvents(), null)
  expect(isClean(log)).toBe(true)
  expect(log).toContain('#7 https://github.com/o/r/pull/7')
  expect(log).toContain('click')
})

test('the band view carries no control characters in titles, versions, the paused reason or events', () => {
  const todo = TODO.replace('Second', `Second${EVIL}`).replace('- version: 0.2', `- version: 0.2${EVIL_BITS[1]}`)
  const items = parseTodo(todo)
  const state = { ...DEFAULT_STATE, approved: true, current: 'T-002', pausedReason: `why${EVIL}`, events: dirtyEvents() }
  const view = buildView(items, state, new Set(), null, null)
  expect(view.rows.some(r => r.title.includes('Second'))).toBe(true)
  expect(strings(view).every(isClean)).toBe(true)
})

test('/factory-status output carries no control characters from titles, versions, blocked notes, reasons, events or settings', () => {
  const todo = TODO.replace('Second', `Second${EVIL}`).replace('- version: 0.2', `- version: 0.2${EVIL_BITS[1]}`)
  const items = parseTodo(todo)
  const state = { ...DEFAULT_STATE, approved: true, autopilot: false, current: 'T-002', pausedReason: `why${EVIL}`, events: dirtyEvents() }
  const text = statusReport({ state, settings: { ...settings, stopAfterVersion: `9${EVIL}` }, items, blocked: new Map([['T-003', `reason${EVIL}`]]), stage: 'CI', now: 5000, runUsd: 1, itemUsd: 1 })
  expect(text).toContain('Second')
  expect(text).toContain('- T-003: reason')
  expect(isClean(text)).toBe(true)
})

test('commit messages and PR urls are stored without control characters', () => {
  const msg = commitMessage(`git commit -m "fix${EVIL}"`)
  expect(msg.startsWith('fix')).toBe(true)
  expect(isClean(msg)).toBe(true)
  const pr = parsePrUrl(`https://github.com/o\x1b[2K\u202e/r/pull/9\x1b]8;;http://evil\x07`)
  expect(pr?.pr).toBe(9)
  expect(isClean(pr!.url)).toBe(true)
  expect(isClean(parseItemArg(`T-001 note${EVIL}`).note)).toBe(true)
})

test('/factory-costs output carries no control characters from repo keys or item titles', () => {
  const rc = normalizeRepoCosts({ repo: `acme/w${EVIL}`, usd: 2, items: { 'T-001': { title: `t${EVIL}`, usd: 2, models: {}, phases: {}, attempts: 1 } }, runs: [], marks: {} }, 'x')
  const text = costsReport([rc], 'all', null)
  expect(text).toContain('T-001')
  expect(isClean(text)).toBe(true)
})

const SHELL_META = ['x>zzt', 'x;reboot', 'x>/tmp/notes.txt', 'a&b', 'a|b', 'a(b)', 'a{b}', 'a!b', 'a#b', 'a%b', 'a<b']
const COMMENT_UNSAFE = /[;&|<>`$()!{}*?\[\]'"\\%#~^]/
const count = (t: string, s: string): number => t.split(s).length - 1
const isComment = (l: string): boolean => l.trim().startsWith('#')

function expectPasteSafe(text: string, name: string): void {
  for (const line of text.split('\n')) {
    if (isComment(line)) {
      expect(line.includes(name)).toBe(false)
      expect(COMMENT_UNSAFE.test(line.trim().slice(1))).toBe(false)
    } else if (/^\s*git /.test(line)) {
      expect(count(line, name)).toBe(count(line, `'${name}'`))
    }
  }
  expect(count(text, name)).toBe(count(text, `'${name}'`))
}

test('names with shell metacharacters are accepted but never printed unquoted, and no comment line carries a branch name', () => {
  for (const name of SHELL_META) {
    expect(isSafeBranchName(name)).toBe(true)
    const asBase = designPushSteps(name, 'feature/x')
    expect(asBase).toContain(`  git checkout '${name}' && `)
    expect(asBase).toContain(` && git push origin '${name}'`)
    expectPasteSafe(asBase, name)
    expectPasteSafe(designPushSteps(name, null), name)
    const asCurrent = designPushSteps('main', name)
    expect(asCurrent).toContain(`git checkout '${name}' -- `)
    expectPasteSafe(asCurrent, name)
    const p = roadmapPrompt(parseTodo(TODO), [], '', { ...settings, baseBranch: name })
    expect(p).toContain(`git push origin '${name}'`)
    expectPasteSafe(p, name)
  }
})

test('the unsafe base note does not echo the rejected name', () => {
  for (const bad of ['$(touch pwn)', 'a`id`b', "it's"]) {
    const steps = designPushSteps(bad, 'feature/x')
    expect(steps).toContain('no git commands are shown')
    expect(steps.includes(bad)).toBe(false)
  }
})

test('every accepted branch name survives the text cleaner unchanged, so the printed block is the same before and after safeLines', () => {
  const accepted = ['main', 'release/1.0', 'dev_2', 'feature/a-b', 'release+x', 'foo@bar', 'feature/a,b', 'a;b', 'x(1)', 'feature/é', 'zh/功能', ...SHELL_META]
  for (const name of accepted) {
    expect(isSafeBranchName(name)).toBe(true)
    expect(cleanText(name)).toBe(name)
    for (const block of [designPushSteps(name, null), designPushSteps(name, 'feature/x'), designPushSteps('main', name)]) expect(safeLines(block)).toBe(block)
  }
  for (const c of CONTROL) {
    expect(isSafeBranchName(`ma${c}in`)).toBe(false)
    const block = designPushSteps('main', `feat${c}x`)
    expect(safeLines(block)).toBe(block)
    expect(block).not.toContain("git checkout 'featx'")
  }
})

test('the push-only alternative pushes design files already committed on the base branch', () => {
  for (const cur of [null, 'feature/x', 'bad name']) {
    const steps = designPushSteps('main', cur)
    expect(steps).toContain("\n  # If the design files are already committed on the base branch but not pushed, run only this line:\n  git checkout 'main' && git push origin 'main'\n")
  }
  for (const name of SHELL_META) expect(designPushSteps(name, null)).toContain(`  git checkout '${name}' && git push origin '${name}'`)
})

test('a branch name starting with + is a force refspec, so it is rejected as base and as current branch; + inside a name stays valid', () => {
  for (const bad of ['+main', '+x/y']) {
    expect(isSafeBranchName(bad)).toBe(false)
    expect(parseSettings(JSON.stringify({ testCmd: ['t'], baseBranch: bad })).problems.join(' ')).toContain('not a plain branch name')
    const asBase = designPushSteps(bad, 'feature/x')
    expect(asBase).not.toMatch(/^\s*git /m)
    expect(roadmapPrompt(parseTodo(TODO), [], '', { ...settings, baseBranch: bad })).not.toMatch(/^\s*git /m)
    const asCurrent = designPushSteps('main', bad)
    expect(asCurrent.includes(bad)).toBe(false)
    expect(asCurrent).toContain('copy them over to the base branch by hand')
  }
  expect(isSafeBranchName('release+x')).toBe(true)
  expect(isSafeBranchName('a+')).toBe(true)
})

test('no printed git push line has a refspec starting with + or :, for any accepted name', () => {
  const accepted = ['main', 'release/1.0', 'release+x', 'foo@bar', 'feature/a,b', 'a;b', 'x(1)', 'feature/\u00e9', ...SHELL_META]
  for (const name of accepted) {
    for (const block of [designPushSteps(name, null), designPushSteps(name, 'feature/x'), designPushSteps('main', name), roadmapPrompt(parseTodo(TODO), [], '', { ...settings, baseBranch: name })]) {
      for (const m of block.matchAll(/git push origin '([^']*)'/g)) expect(/^[+:]/.test(m[1]!)).toBe(false)
      expect(/git push origin (?!')/.test(block)).toBe(false)
    }
  }
})

test('the interview-complete marker is recognised only as the last line', () => {
  expect(isRoadmapDone('All recorded.\nROADMAP-DONE')).toBe(true)
  expect(isRoadmapDone('All recorded.\n  ROADMAP-DONE  \n\n')).toBe(true)
  expect(isRoadmapDone('ROADMAP-DONE')).toBe(true)
  expect(isRoadmapDone('I will write ROADMAP-DONE at the end.')).toBe(false)
  expect(isRoadmapDone('ROADMAP-DONE\nWhich version next?')).toBe(false)
  expect(isRoadmapDone('')).toBe(false)
})
