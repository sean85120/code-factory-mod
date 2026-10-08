import { expect, mock, test } from 'claude-code/testing'

import { DEFAULT_STATE, agentActions, agentSummary, buildView, decisionsHash, itemSteps, parseSettings, parseTodo, progressBar, statusLine } from '../hooks/lib'
import type { FactoryEvent, FactoryView } from '../hooks/lib'

const TODO = `## T-001 [feature] First
- status: done
- how: Use the standard library only, because zero dependencies.
- accept: The first thing works for documented inputs.
- tests: Unit tests for each input.

## T-002 [feature] Second
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The second thing works for documented inputs.
- tests: Unit tests for each input.

## T-003 [chore] Third
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The third thing works for documented inputs.
- tests: Unit tests for each input.
`

const ev = (kind: FactoryEvent['kind'], extra: Partial<FactoryEvent> = {}): FactoryEvent => ({ ts: 1_000, itemId: 'T-002', kind, detail: '', ...extra })

test('progressBar fills in proportion and never leaves its width', () => {
  expect(progressBar(0, 4, 8)).toBe('░░░░░░░░')
  expect(progressBar(2, 4, 8)).toBe('████░░░░')
  expect(progressBar(4, 4, 8)).toBe('████████')
  expect(progressBar(9, 4, 8)).toBe('████████')
  expect(progressBar(-3, 4, 8)).toBe('░░░░░░░░')
  expect(progressBar(1, 0, 8)).toBe('░░░░░░░░')
  expect(progressBar(96, 100, 10)).toBe('█████████░')
  expect(progressBar(Number.NaN, 4, 8)).toBe('░░░░░░░░')
  expect(progressBar(1, 2, 0)).toHaveLength(1)
})

test('agentActions reads the newest tool calls and prose of an agent, one line each, without control characters', () => {
  const msgs = [
    { role: 'user', text: 'do it', toolUses: [] },
    { role: 'assistant', text: 'reading', toolUses: [{ tool: 'Read', input: { file_path: '/repo/a.ts' } }] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'bun test\n--bail\u001b[31m' } }] },
    { role: 'assistant', text: 'All checks pass.\nSecond line', toolUses: [] },
  ]
  expect(agentActions(msgs)).toEqual(['Read: /repo/a.ts', 'Bash: bun test --bail[31m', 'All checks pass.'])
  expect(agentActions(msgs, 1)).toEqual(['All checks pass.'])
  expect(agentActions(msgs, 0)).toEqual([])
  expect(agentSummary(msgs)).toBe('All checks pass.')
  expect(agentSummary([])).toBe('')
  const long = [{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'x'.repeat(500) } }] }]
  expect(agentActions(long)[0]!.length).toBeLessThan(90)
})

test('itemSteps marks stages before the current one done and carries the evidence for each', () => {
  const events = [ev('started'), ev('commit'), ev('commit'), ev('pr-opened', { pr: 7 }), ev('ci-passed')]
  const steps = itemSteps('CI', events, 'T-002', { attempt: 2, maxAttempts: 3, reviewRound: 1, maxReviewRounds: 3 })
  expect(steps.map(s => `${s.label}:${s.state}`)).toEqual(['build:done', 'review:done', 'PR:done', 'CI:doing', 'merge:todo'])
  expect(steps[0]!.detail).toBe('2 commits · attempt 2/3')
  expect(steps[1]!.detail).toBe('round 1/3')
  expect(steps[2]!.detail).toBe('#7')
  expect(steps[3]!.detail).toBe('passed')
  expect(itemSteps('build', [], null, { attempt: 0, maxAttempts: 3, reviewRound: 0, maxReviewRounds: 3 })).toEqual([])
  const fresh = itemSteps('build', [ev('commit'), ev('started')], 'T-002', { attempt: 0, maxAttempts: 3, reviewRound: 0, maxReviewRounds: 3 })
  expect(fresh[0]!.detail).toBe('0 commits · attempt 1/3')
  expect(fresh[2]!.detail).toBe('not opened')
})

test('itemSteps ignores events of other items and of an earlier run of the same item', () => {
  const events = [ev('started'), ev('pr-opened', { pr: 1 }), ev('started'), ev('commit'), ev('commit', { itemId: 'T-003' })]
  const steps = itemSteps('build', events, 'T-002', { attempt: 1, maxAttempts: 3, reviewRound: 0, maxReviewRounds: 3 })
  expect(steps[0]!.detail).toBe('1 commit · attempt 1/3')
  expect(steps[2]!.detail).toBe('not opened')
})

test('buildView adds totals, blocked count, attempts, PR, elapsed time, steps and capped agents', () => {
  const items = parseTodo(TODO)
  const agents = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `agent ${i}`, kind: 'general-purpose', status: 'running', summary: 'x', recent: [], parent: null }))
  const state = { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-002', attempts: 2, reviewRounds: 1, approvedDone: ['T-001'], events: [ev('started', { ts: 4_000 }), ev('pr-opened', { ts: 5_000, pr: 4 })] }
  const v = buildView(items, state, new Set(['T-003']), null, null, undefined, { maxAttempts: 3, maxReviewRounds: 3, agents, now: 70_000 })
  expect(v.total).toBe(3)
  expect(v.blockedCount).toBe(1)
  expect(v.attempt).toBe(2)
  expect(v.maxAttempts).toBe(3)
  expect(v.reviewRound).toBe(1)
  expect(v.prNumber).toBe(4)
  expect(v.elapsedMs).toBe(66_000)
  expect(v.steps).toHaveLength(5)
  expect(v.agents).toHaveLength(6)
})

test('buildView without a started event has no elapsed time and without a current item no steps', () => {
  const items = parseTodo(TODO)
  const v = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: true }, new Set(), null, null)
  expect(v.elapsedMs).toBeNull()
  expect(v.steps).toEqual([])
  expect(v.prNumber).toBeNull()
})

const base = (o: Partial<FactoryView> = {}): FactoryView => ({
  approved: true,
  running: true,
  pausedReason: null,
  current: 'T-002',
  stage: 'review',
  summary: '',
  doneCount: 1,
  rows: [],
  more: 0,
  marks: {},
  changes: [],
  runUsd: null,
  itemUsd: null,
  budgetUsd: 0,
  events: [],
  total: 3,
  blockedCount: 0,
  ...o,
})

test('statusLine shows the item, stage bar, progress, what is left, spend against the budget, agents and time', () => {
  const line = statusLine(base({ runUsd: 2.55, itemUsd: 1, budgetUsd: 6, attempt: 2, maxAttempts: 3, reviewRound: 1, maxReviewRounds: 3, elapsedMs: 150_000, agents: [{ id: 'a', label: 'rev', kind: 'g', status: 'running', summary: '', recent: [], parent: null }] }))
  expect(line).toContain('factory ▶ T-002')
  expect(line).toContain('review ██░░░ 2/5')
  expect(line).toContain('attempt 2/3')
  expect(line).toContain('review 1/3')
  expect(line).toContain('1/3 done')
  expect(line).toContain('2 to do')
  expect(line).toContain('$2.55/$6.00')
  expect(line).toContain('1 agent')
  expect(line).not.toContain('1 agents')
  expect(line).toContain('2m30s')
})

test('statusLine counts blocked items out of what is left, says when nothing is left, and shows spend without a budget', () => {
  expect(statusLine(base({ blockedCount: 1 }))).toContain('1 to do')
  expect(statusLine(base({ blockedCount: 1 }))).toContain('1 blocked')
  expect(statusLine(base({ doneCount: 3, current: null, stage: null }))).toContain('nothing left')
  expect(statusLine(base({ runUsd: 0.5 }))).toContain('$0.50 spent')
  expect(statusLine(base({ approved: false }))).toBe('factory: design not approved')
})

test('statusLine shortens a long pause reason to one line and drops the stage of a paused loop', () => {
  const line = statusLine(base({ running: false, current: 'T-002', pausedReason: `budgetUsd is $6.00 but this run's spend cannot be read ${'x'.repeat(200)}` }))
  expect(line.split(' · ')[0]!.length).toBeLessThan(100)
  expect(line).toContain('factory ⏸')
  expect(line).not.toContain('2/5')
})

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const SETTINGS = JSON.stringify({ testCmd: ['unit'], baseBranch: 'main', requireReview: false, requireTestChanges: false, allowTestRemoval: true })

function fixture($: any, on: any, o: { agents?: any[]; messages?: Record<string, any[]>; statuses?: (string | undefined)[]; rosterFails?: boolean; reads?: { n: number } } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const hash = decisionsHash(parseSettings(SETTINGS).settings, parseTodo(TODO))
  const files: Record<string, string> = {
    '.factory/settings.json': SETTINGS,
    '.factory/todo.md': TODO,
    '.factory/state.json': JSON.stringify({ approved: true, approvedHash: hash, autopilot: true, current: 'T-002', approvedDone: ['T-001'], events: [{ ts: 999_000, itemId: 'T-002', kind: 'started', detail: '' }] }),
  }
  const key = (path: string) => Object.keys(files).find(k => path.endsWith(`/${k}`))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: key(e.path) !== undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files[key(e.path) ?? ''] ?? '' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: ok('') }))
  on('ui.status', (_: unknown, e: { text?: string }) => {
    o.statuses?.push(e.text)
    return { value: undefined }
  })
  on('agent.list', () => {
    if (o.rosterFails) throw new Error('gone')
    return { value: o.agents ?? [] }
  })
  on('session.messages', (_: unknown, e: { agentId?: string }) => {
    if (o.reads && e.agentId === 'rev1') o.reads.n++
    return { value: (o.messages?.[e.agentId ?? 'main'] ?? []) as never }
  })
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'base' }))
  return clock
}

const REVIEWER = { id: 'rev1', description: 'Independent review of T-002', type: 'general-purpose', status: 'running', parentId: undefined }
const REVIEWER_LOG = [
  { role: 'assistant', text: '', toolUses: [{ tool: 'Read', input: { file_path: '/repo/src/title.ts' } }] },
  { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'bun test' } }] },
]

async function band($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'code-factory', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as never)
}

test('the band lists a running subagent with its latest action as a one-line summary', async ($, on) => {
  fixture($, on, { agents: [REVIEWER], messages: { rev1: REVIEWER_LOG } })
  await $.command.run({ command: 'factory-status' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ text: /Independent review of T-002 · running · Bash: bun test/ })).toBeDefined()
    expect(await ui.find({ text: /1\/3 done/ })).toBeDefined()
    expect(await ui.find({ text: /● build/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the status line carries progress, what is left and the agent count, and refreshes when an agent appears', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const agents: any[] = []
  fixture($, on, { agents, messages: { rev1: REVIEWER_LOG }, statuses })
  await $.command.run({ command: 'factory-status' } as never)
  const first = statuses.at(-1)!
  expect(first).toContain('factory ▶ T-002')
  expect(first).toContain('1/3 done')
  expect(first).toContain('2 to do')
  expect(first).not.toContain('agent')
  agents.push(REVIEWER)
  await $.command.run({ command: 'factory-status' } as never)
  expect(statuses.at(-1)).toContain('1 agent')
})

test('the dashboard pane lists the steps of the item and an agent opens to its recent actions when pressed', async ($, on) => {
  fixture($, on, { agents: [REVIEWER], messages: { rev1: REVIEWER_LOG } })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await ui.find({ text: /Plan/ })).toBeDefined()
  expect(await ui.find({ text: /● build/ })).toBeDefined()
  expect(await ui.find({ text: /Agents · 1/ })).toBeDefined()
  expect(await ui.find({ text: /Read: \/repo\/src\/title\.ts/ })).toBeUndefined()
  await ui.press({ key: 'agent-rev1' })
  expect(await ui.find({ text: /Read: \/repo\/src\/title\.ts/ })).toBeDefined()
  expect(await ui.find({ text: /Bash: bun test/ })).toBeDefined()
  await ui.press({ key: 'agent-rev1' })
  expect(await ui.find({ text: /Read: \/repo\/src\/title\.ts/ })).toBeUndefined()
  await ui.unmount()
})

test('pressing an agent in the band opens the pane on it', async ($, on) => {
  fixture($, on, { agents: [REVIEWER], messages: { rev1: REVIEWER_LOG } })
  const opened: string[] = []
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await band($)
  await ui.press({ key: 'agent-rev1' })
  expect(opened).toContain('factory')
  await ui.unmount()
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await pane.find({ text: /Read: \/repo\/src\/title\.ts/ })).toBeDefined()
  await pane.unmount()
})

test('/factory-dashboard opens the pane', async ($, on) => {
  fixture($, on)
  const opened: string[] = []
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  const out = await $.command.run({ command: 'factory-dashboard' } as never)
  expect(opened).toEqual(['factory'])
  expect(JSON.stringify(out)).toContain('dashboard')
})

test('a failing agent roster or transcript read never breaks the band', async ($, on) => {
  fixture($, on, { rosterFails: true })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await band($)
  expect(await ui.find({ text: /T-002/ })).toBeDefined()
  await ui.unmount()
})

test('proposed items are not part of the plan total, so a finished plan reads as nothing left', () => {
  const todo = TODO.replace('status: todo', 'status: done').replace('status: todo', 'status: done') + `
## T-004 [chore] Proposed
- status: proposed
- how: Use the standard library only, because zero dependencies.
- accept: The proposed thing works for documented inputs.
- tests: Unit tests for each input.
`
  const items = parseTodo(todo)
  const v = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: true, approvedDone: ['T-001', 'T-002', 'T-003'] }, new Set(), null, null)
  expect(v.total).toBe(3)
  expect(statusLine(v)).toContain('3/3 done')
  expect(statusLine(v)).toContain('nothing left')
})

test('an agent description with an escape sequence reaches the band clean', async ($, on) => {
  fixture($, on, { agents: [{ ...REVIEWER, description: 'Review\u001b[2J of T-002' }], messages: { rev1: REVIEWER_LOG } })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await band($)
  expect(await ui.find({ text: /Review\[2J of T-002/ })).toBeDefined()
  expect(await ui.find({ text: /\u001b/ })).toBeUndefined()
  await ui.unmount()
})

test('an active agent is not re-read within the throttle window, a finished one never', async ($, on) => {
  const reads = { n: 0 }
  const clock = fixture($, on, { agents: [REVIEWER], messages: { rev1: REVIEWER_LOG }, reads })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-status' } as never)
  expect(reads.n).toBe(1)
  await clock.advance(7000)
  await $.command.run({ command: 'factory-status' } as never)
  expect(reads.n).toBe(2)
})

test('the main loop row is not counted as a subagent in the status line', () => {
  const main = { id: 'main', label: 'T-002 (main loop)', kind: 'main', status: 'running', summary: 'x', recent: [], parent: null }
  expect(statusLine(base({ agents: [main] }))).not.toContain('agent')
})
