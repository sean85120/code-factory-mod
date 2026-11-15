import { expect, mock, test } from 'claude-code/testing'

import { DEFAULT_STATE, VOX_CELL_COLUMNS, VOX_CELL_ROWS, hackerTheme, unpackCells, DEFAULT_THEME_CAPS, agentActions, agentTranscript, checksReport, controlsFor, isCompact, agentSummary, buildView, decisionsHash, itemSteps, parseSettings, parseTodo, progressBar, statusLine } from '../hooks/lib'
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

function fixture($: any, on: any, o: { runs?: string[][]; autopilot?: boolean; blocked?: string[]; writes?: { path: string; text: string }[]; agents?: any[]; store?: Record<string, unknown>; env?: Record<string, string>; claudeTheme?: string; messages?: Record<string, any[]>; statuses?: (string | undefined)[]; rosterFails?: boolean; reads?: { n: number }; approved?: boolean } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  if (o.store) mock.store(on, o.store)
  if (o.env) mock.env(on, o.env)
  if (o.claudeTheme) on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: o.claudeTheme, provider: { plugin: 'engine' }, isLocked: false }] as never }))
  const hash = decisionsHash(parseSettings(SETTINGS).settings, parseTodo(TODO))
  const files: Record<string, string> = {
    '.factory/settings.json': SETTINGS,
    '.factory/todo.md': TODO,
    '.factory/state.json': JSON.stringify({ approved: o.approved ?? true, approvedHash: hash, autopilot: o.autopilot ?? true, current: o.autopilot === false ? null : 'T-002', approvedDone: ['T-001'], events: [{ ts: 999_000, itemId: 'T-002', kind: 'started', detail: '' }] }),
  }
  for (const id of o.blocked ?? []) files[`.factory/blocked/${id}.md`] = 'Skipped by you: needs a product decision. /factory-retry makes it eligible again.\n'
  const key = (path: string) => Object.keys(files).find(k => path.endsWith(`/${k}`))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: key(e.path) !== undefined || (e.path.endsWith('.factory/blocked') && (o.blocked?.length ?? 0) > 0) }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files[key(e.path) ?? ''] ?? '' }))
  on('fs.list', () => ({ value: (o.blocked ?? []).map(id => ({ name: `${id}.md` })) as never }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    o.writes?.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    o.runs?.push(e.argv)
    return { value: ok('') }
  })
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

test('an opened agent shows its transcript: task, words, tool calls with results and errors', async ($, on) => {
  const log = [
    { role: 'user', text: 'Review the branch for T-002', toolUses: [] },
    { role: 'assistant', text: 'Reading the diff first', toolUses: [{ tool: 'Bash', input: { command: 'git diff' }, text: '3 files changed' }] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Read', input: { file_path: 'nope.ts' }, isError: true, text: 'no such file' }] },
  ]
  fixture($, on, { agents: [REVIEWER], messages: { rev1: log } })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await ui.find({ text: /» task: Review the branch/ })).toBeUndefined()
  await ui.press({ key: 'agent-rev1' })
  for (const re of [/» task: Review the branch for T-002/, /› Reading the diff first/, /⚙ Bash: git diff/, /↳ 3 files changed/, /✗ no such file/]) expect(await ui.find({ text: re })).toBeDefined()
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

test('controlsFor offers pause and stop while running, start when not, and a retry per blocked row', () => {
  const view = (o: Partial<FactoryView>): FactoryView => ({ ...buildView(parseTodo(TODO), { ...DEFAULT_STATE, approved: true }, new Set(), null, null), ...o })
  expect(controlsFor(view({ running: true })).map(c => c.command)).toEqual(['factory-pause', 'factory-stop'])
  expect(controlsFor(view({ running: false })).map(c => c.command)).toEqual(['factory-start'])
  expect(controlsFor(view({ approved: false }))).toEqual([])
  const blocked = view({ running: false, rows: [{ id: 'T-002', type: 'feature', title: 'Second', version: '', mark: 'blocked' }, { id: 'T-003', type: 'chore', title: 'Third', version: '', mark: 'todo' }] })
  expect(controlsFor(blocked).filter(c => c.command === 'factory-retry')).toEqual([{ key: 'retry-T-002', label: '↻ retry T-002', command: 'factory-retry', args: 'T-002' }])
})

test('buildView lists blocked items with the first line of their note', () => {
  const items = parseTodo(TODO)
  const v = buildView(items, { ...DEFAULT_STATE, approved: true }, new Set(['T-003']), null, null, undefined, { maxAttempts: 3, maxReviewRounds: 3, agents: [], now: 0, notes: new Map([['T-003', 'needs\u001b[31m a decision']]) })
  expect(v.blocked).toEqual([{ id: 'T-003', title: 'Third', reason: 'needs[31m a decision' }])
})

test('checksReport counts problems and warnings and marks each line', () => {
  expect(checksReport([{ name: 'gh login', status: 'ok', detail: '' }])).toBe('Factory checks: ready to run\n✓ gh login')
  const mixed = checksReport([{ name: 'gh login', status: 'fail', detail: 'run `gh auth login`' }, { name: 'working tree', status: 'warn', detail: '2 uncommitted changes' }])
  expect(mixed).toContain('1 problem to fix before /factory-start')
  expect(mixed).toContain('✗ gh login · run `gh auth login`')
  expect(mixed).toContain('! working tree · 2 uncommitted changes')
  expect(checksReport([{ name: 'a', status: 'warn', detail: '' }])).toContain('ready, 1 warning')
})

test('isCompact is true only for a known narrow width', () => {
  expect(isCompact(60)).toBe(true)
  expect(isCompact(89)).toBe(true)
  expect(isCompact(90)).toBe(false)
  expect(isCompact(undefined)).toBe(false)
})

test('pressing pause in the band runs /factory-pause', async ($, on) => {
  const toasts: string[] = []
  const clock = fixture($, on)
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await band($)
  expect(await ui.find({ text: /⏸ pause/ })).toBeDefined()
  await ui.press({ key: 'pause' })
  await clock.advance(2000)
  expect(toasts).toContain('factory paused: paused by you; /factory-start resumes')
  await ui.unmount()
})

test('the band drops spend, steps and events at a narrow width', async ($, on) => {
  fixture($, on)
  await $.command.run({ command: 'factory-status' } as never)
  const wide = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 140 } } as never)
  expect(await wide.find({ text: /● build/ })).toBeDefined()
  expect(await wide.find({ text: /⋯/ })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 60 } } as never)
  expect(await narrow.find({ text: /1\/3 done/ })).toBeDefined()
  expect(await narrow.find({ text: /● build/ })).toBeUndefined()
  expect(await narrow.find({ text: /⋯/ })).toBeUndefined()
  await narrow.unmount()
})

test('pressing stop in the band stops the loop', async ($, on) => {
  const toasts: string[] = []
  const clock = fixture($, on)
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await band($)
  await ui.press({ key: 'stop' })
  await clock.advance(2000)
  expect(toasts).toContain('Factory paused. The current turn finishes; nothing new starts. /factory-start resumes.')
  await ui.unmount()
})

test('pressing start in the band starts a paused loop', async ($, on) => {
  const toasts: string[] = []
  const clock = fixture($, on, { autopilot: false })
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await band($)
  expect(await ui.find({ text: /▶ start/ })).toBeDefined()
  await ui.press({ key: 'start' })
  await clock.advance(2000)
  expect(toasts.some(t => t.startsWith('Cannot start') || t.startsWith('Factory running'))).toBe(true)
  await ui.unmount()
})

test('start is refused while a main turn is running', async ($, on) => {
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  const toasts: string[] = []
  const clock = fixture($, on, { autopilot: false })
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.command.run({ command: 'factory-status' } as never)
  await $.turn.start({ text: 'my own prompt', turnId: 't1' } as never)
  const ui = await band($)
  await ui.press({ key: 'start' })
  await clock.advance(2000)
  expect(toasts.some(t => t.includes('a turn is still running'))).toBe(true)
  await ui.unmount()
})

test('the panel skips a todo item with a typed reason and lists blocked items with their note and a retry button', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const clock = fixture($, on, { writes })
  await $.command.run({ command: 'factory-status' } as never)
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await pane.find({ key: 'skip-reason' })).toBeUndefined()
  await pane.press({ key: 'skip-T-003' })
  expect(await pane.find({ key: 'skip-reason' })).toBeDefined()
  await (pane as any).input({ key: 'skip-reason', text: 'needs a decision', kind: 'submit' })
  await clock.advance(2000)
  expect(writes.some(w => w.path.endsWith('.factory/blocked/T-003.md') && w.text.includes('needs a decision'))).toBe(true)
  await pane.unmount()
})

test('the panel shows a blocked item with its note', async ($, on) => {
  fixture($, on, { blocked: ['T-003'] })
  await $.command.run({ command: 'factory-status' } as never)
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await pane.find({ text: /Blocked · 1/ })).toBeDefined()
  expect(await pane.find({ text: /Skipped by you: needs a product decision/ })).toBeDefined()
  expect(await pane.find({ text: /↻ retry/ })).toBeDefined()
  await pane.unmount()
})

test('/factory-doctor reports the checks', async ($, on) => {
  fixture($, on)
  const out = await $.command.run({ command: 'factory-doctor' } as never)
  expect(out.text).toContain('Factory checks:')
  expect(out.text).toContain('gh login')
})

test('the check button in the panel runs the checks and shows them', async ($, on) => {
  const clock = fixture($, on)
  await $.command.run({ command: 'factory-status' } as never)
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await pane.find({ text: /^Checks$/ })).toBeUndefined()
  await pane.press({ key: 'doctor' })
  await clock.advance(2000)
  expect(await pane.find({ text: /^Checks$/ })).toBeDefined()
  await pane.unmount()
})

test('the retry button in the panel removes that item\'s blocked note', async ($, on) => {
  const runs: string[][] = []
  const clock = fixture($, on, { blocked: ['T-003'], runs })
  await $.command.run({ command: 'factory-status' } as never)
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  await pane.press({ key: 'retry-T-003' })
  await clock.advance(2000)
  expect(runs.some(a => a[0] === 'rm' && a.includes('.factory/blocked/T-003.md'))).toBe(true)
  await pane.unmount()
})

test('the panel offers skip on the current and todo items only, and its own run controls', async ($, on) => {
  fixture($, on, { blocked: ['T-003'] })
  await $.command.run({ command: 'factory-status' } as never)
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await pane.find({ key: 'skip-T-002' })).toBeDefined()
  expect(await pane.find({ key: 'skip-T-003' })).toBeUndefined()
  expect(await pane.find({ key: 'pause' })).toBeDefined()
  expect(await pane.find({ key: 'stop' })).toBeDefined()
  await pane.unmount()
})

test('a narrow band keeps only the run controls, not a retry per blocked item', async ($, on) => {
  fixture($, on, { blocked: ['T-003'] })
  await $.command.run({ command: 'factory-status' } as never)
  const wide = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 140 } } as never)
  expect(await wide.find({ key: 'retry-T-003' })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 60 } } as never)
  expect(await narrow.find({ key: 'retry-T-003' })).toBeUndefined()
  expect(await narrow.find({ key: 'pause' })).toBeDefined()
  await narrow.unmount()
})

test('before approval the pane is a getting-started guide and the band is one line', async ($, on) => {
  fixture($, on, { approved: false, autopilot: false })
  await $.command.run({ command: 'factory-status' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'code-factory', surface, component: 'Pane', requestId: 'factory', props: {} } as never)
    expect(await pane.find({ text: /getting started/ })).toBeDefined()
    expect(await pane.find({ text: /✓ 1 Design/ })).toBeDefined()
    expect(await pane.find({ text: /● 2 Approve/ })).toBeDefined()
    expect(await pane.find({ text: /\/factory-approve/ })).toBeDefined()
    expect(await pane.find({ text: /✔ approve/ })).toBeDefined()
    expect(await pane.find({ text: /check setup/ })).toBeDefined()
    await pane.unmount()
    const ui = await band($, surface)
    expect(await ui.find({ text: /design drafted/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a paused dashboard says what to do next and offers issue triage', async ($, on) => {
  fixture($, on, { autopilot: false })
  await $.command.run({ command: 'factory-status' } as never)
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect(await pane.find({ text: /\/factory-start carries on/ })).toBeDefined()
  expect(await pane.find({ text: /triage issues/ })).toBeDefined()
  expect(await pane.find({ text: /● 3 Build/ })).toBeDefined()
  expect(await pane.find({ text: /next phase/ })).toBeUndefined()
  await pane.unmount()
})

test('an agent transcript lists its task, its words, each tool call with its result or error, newest lines last', () => {
  const lines = agentTranscript([
    { role: 'user', text: 'Review the branch', toolUses: [] },
    { role: 'assistant', text: 'Reading the diff\n\nand the tests', toolUses: [{ tool: 'Bash', input: { command: 'git diff' }, text: '3 files changed\nmore' }, { tool: 'Read', input: { file_path: 'a.ts' }, isError: true, text: 'no such file' }] },
    { role: 'user', text: 'ignored later user text', toolUses: [] },
  ])
  expect(lines).toEqual(['» task: Review the branch', '› Reading the diff', '› and the tests', '⚙ Bash: git diff', '  ↳ 3 files changed', '⚙ Read: a.ts', '  ✗ no such file'])
  expect(agentTranscript([{ role: 'assistant', text: 'a\nb\nc', toolUses: [] }], 2)).toEqual(['› b', '› c'])
  expect(agentTranscript([], 5)).toEqual([])
  expect(agentTranscript([{ role: 'assistant', text: 'x\u001b[31my', toolUses: [] }])).toEqual(['› x[31my'])
})

const doingColor = async (ui: any) => (await ui.find({ text: /^[▶▸] T-002$/ }))?.props.color

test('the classic look is the default and the hacker look recolors the band and pane from the stored choice', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  const before = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  expect(await doingColor(before)).toBe('yellow')
  await before.unmount()
  await $.command.run({ command: 'factory-theme' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'code-factory', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as never)
    expect(await doingColor(ui)).toBe('#FFB000')
    await ui.unmount()
  }
  const pane = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: {} } as never)
  expect((await pane.find({ text: /Plan/ }))?.props.color).toBeUndefined()
  expect(await doingColor(pane)).toBe('#FFB000')
  await pane.unmount()
})

for (const [claudeTheme, env, want] of [['light', {}, '#9A5B00'], ['dark-ansi', {}, 'yellow'], ['dark', { NO_COLOR: '1' }, undefined]] as const) {
  test(`the hacker look follows the Claude theme "${claudeTheme}" and NO_COLOR ${JSON.stringify(env)}`, async ($, on) => {
    fixture($, on, { store: { 'ui/theme': { name: 'hacker' } }, claudeTheme, env: { ...env } })
    await $.command.run({ command: 'factory-status' } as never)
    await $.command.run({ command: 'factory-theme' } as never)
    const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
    expect(await ui.find({ text: /^▸ T-002$/ })).toBeDefined()
    expect(await doingColor(ui)).toBe(want)
    await ui.unmount()
  })
}

test('/factory-theme saves the choice in the store only, reports it, refuses unknown words and never writes the repo', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  fixture($, on, { writes, store: {} })
  const run = async (args: string) => (await $.command.run({ command: 'factory-theme', args } as never)) as any
  expect(JSON.stringify(await run(''))).toContain('Look: classic')
  expect(JSON.stringify(await run('hacker'))).toContain('Look: hacker (dark)')
  expect(JSON.stringify(await run(''))).toContain('Look: hacker')
  expect(JSON.stringify(await run('neon'))).toContain('Usage: /factory-theme')
  expect(JSON.stringify(await run(''))).toContain('Look: hacker')
  expect(JSON.stringify(await run('classic'))).toContain('Look: classic')
  expect(writes.filter(w => w.path.includes('.factory/'))).toEqual([])
})

const mountBand = (ui: any, bodyColumns?: number) => ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, ...(bodyColumns === undefined ? {} : { bodyColumns }) } } as never)
const mountPane = (ui: any, bodyColumns?: number) => ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: { ...(bodyColumns === undefined ? {} : { bodyColumns }) } } as never)

test('the hacker band draws the sigil, a state badge, hacker glyphs and swapped control glyphs, and pressing a control still works', async ($, on) => {
  const toasts: string[] = []
  const clock = fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const ui = await mountBand($.ui, 140)
  expect(await ui.find({ text: /^❯ factory \[RUN\] T-002$/ })).toBeDefined()
  expect(await ui.find({ text: /^\(o_o\)$/ })).toBeDefined()
  expect(await ui.find({ text: /▸ build/ })).toBeDefined()
  expect(await ui.find({ text: /‖ pause/ })).toBeDefined()
  expect(await ui.find({ text: /■ stop/ })).toBeDefined()
  expect(await ui.find({ text: /◆ 1 done/ })).toBeDefined()
  expect(await ui.find({ text: /»/ })).toBeDefined()
  expect(await ui.find({ text: /⏸|▶ T-002|✓|⋯/ })).toBeUndefined()
  await ui.press({ key: 'pause' })
  await clock.advance(2000)
  expect(toasts).toContain('factory paused: paused by you; /factory-start resumes')
  await ui.unmount()
})

test('a paused hacker band shows the HOLD badge and the start control', async ($, on) => {
  fixture($, on, { autopilot: false, store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const ui = await mountBand($.ui)
  expect(await ui.find({ text: /^❯ factory \[HOLD\]/ })).toBeDefined()
  expect(await ui.find({ text: /▸ start/ })).toBeDefined()
  expect(await ui.find({ text: /⏸|▶ start/ })).toBeUndefined()
  await ui.unmount()
})

test('the narrow hacker band still drops the step row and events', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const narrow = await mountBand($.ui, 60)
  expect(await narrow.find({ text: /\[RUN\]/ })).toBeDefined()
  expect(await narrow.find({ text: /▸ build/ })).toBeUndefined()
  expect(await narrow.find({ text: /»/ })).toBeUndefined()
  await narrow.unmount()
})

test('the hacker pane draws section rules sized to the pane and the ascii tier uses only ASCII glyphs', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const pane = await mountPane($.ui, 60)
  const found = async (ui: any, res: RegExp[]) => Object.fromEntries(await Promise.all(res.map(async r => [String(r), (await ui.find({ text: r })) !== undefined])))
  expect(await found(pane, [/^── Plan /, /^── Agents/, /^── Recent/, /^── T-002 /, /▸ T-002/])).toEqual({ '/^── Plan /': true, '/^── Agents/': true, '/^── Recent/': true, '/^── T-002 /': true, '/▸ T-002/': true })
  await pane.unmount()
  await $.command.run({ command: 'factory-theme', args: 'ascii' } as never)
  const ascii = await mountPane($.ui, 60)
  expect(await found(ascii, [/^-- Plan /, /^-- Agents/, /^-- Recent/, /> T-002/])).toEqual({ '/^-- Plan /': true, '/^-- Agents/': true, '/^-- Recent/': true, '/> T-002/': true })
  expect(await ascii.find({ text: /[‖■▸◆◇✖▰▱─]/ })).toBeUndefined()
  await ascii.unmount()
})

test('a non-UTF-8 locale picks the ascii tier on its own and the classic look ignores it', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker' } }, env: { LANG: 'C' } })
  await $.command.run({ command: 'factory-status' } as never)
  expect(JSON.stringify(await $.command.run({ command: 'factory-theme' } as never))).toContain('ascii glyphs, the locale is not UTF-8')
  const ui = await mountBand($.ui, 140)
  expect(await ui.find({ text: /^> factory \[RUN\] T-002$/ })).toBeDefined()
  await ui.unmount()
  expect(JSON.stringify(await $.command.run({ command: 'factory-theme', args: 'classic' } as never))).toContain('Look: classic.')
  const classic = await mountBand($.ui, 140)
  expect(await classic.find({ text: /^factory ▶ T-002$/ })).toBeDefined()
  await classic.unmount()
})

test('the status line under the hacker look carries the sigil and badge and none of the emoji-width glyphs', () => {
  const items = parseTodo(TODO)
  const running = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-002', approvedDone: ['T-001'] }, new Set(), null, null)
  const paused = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: false, pausedReason: 'paused by you', approvedDone: ['T-001'] }, new Set(), null, null)
  const t = hackerTheme(DEFAULT_THEME_CAPS)
  expect(statusLine(running, t)).toMatch(/^\(o_o\) ❯ factory \[RUN\] T-002 · /)
  expect(statusLine(running, t)).toContain('▰')
  expect(statusLine(paused, t)).toMatch(/^\(-_-\) ❯ factory \[HOLD\] paused by you/)
  for (const line of [statusLine(running, t), statusLine(paused, t)]) expect(line).not.toMatch(/[⏸▶█░]/)
  expect(statusLine(running)).toMatch(/^factory ▶ T-002/)
  expect(statusLine(paused)).toMatch(/^factory ⏸ paused by you/)
  expect(statusLine(running, hackerTheme(DEFAULT_THEME_CAPS, true))).toMatch(/^\(o_o\) > factory \[RUN\] T-002 · /)
})

test('the wide hacker pane shows the bot and what it is doing, the narrow one and the classic look do not', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const wide = await mountPane($.ui, 65)
  expect(await wide.find({ text: /\.-""\*""-\./ })).toBeDefined()
  expect(await wide.find({ text: /\(o\)   \(o\)/ })).toBeDefined()
  expect(await wide.find({ text: /^» working on T-002$/ })).toBeDefined()
  expect(await wide.find({ text: /^» next: T-003$/ })).toBeDefined()
  await wide.unmount()
  const narrow = await mountPane($.ui, 40)
  expect(await narrow.find({ text: /\.-""/ })).toBeUndefined()
  expect(await narrow.find({ text: /^» working on/ })).toBeUndefined()
  await narrow.unmount()
  await $.command.run({ command: 'factory-theme', args: 'classic' } as never)
  const classic = await mountPane($.ui, 80)
  expect(await classic.find({ text: /\.-""/ })).toBeUndefined()
  expect(await classic.find({ text: /^» working on/ })).toBeUndefined()
  await classic.unmount()
  const band = await mountBand($.ui, 140)
  expect(await band.find({ text: /^\(o_o\)$/ })).toBeUndefined()
  await band.unmount()
})

const blitsOf = ($: any, on: any, answer: () => unknown = () => ({})) => {
  const blits: { requestId: string; key: string; cells: string }[] = []
  on('ui.panes', () => ({ value: [{ id: 'factory', title: 'Code factory', isPlaced: true }] }))
  on('ui.blit', (_: unknown, e: { requestId: string; key: string; cells: string }) => {
    blits.push(e)
    return { value: answer() }
  })
  return blits
}

test('a wide hacker terminal pane draws a Raster face with decodable cells and the desktop draws the Svg face', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const pane = await mountPane($.ui, 80)
  const r = await pane.find({ type: 'Raster' })
  expect(r?.props.key).toBe('vox')
  expect([r?.props.columns, r?.props.rows]).toEqual([VOX_CELL_COLUMNS, VOX_CELL_ROWS])
  const words = unpackCells(r?.props.cells as string)
  expect(words).toHaveLength(VOX_CELL_COLUMNS * VOX_CELL_ROWS * 3)
  for (let i = 0; i < words.length; i += 3) {
    expect([0x20, 0x2580, 0x2584]).toContain(words[i])
    for (const c of [words[i + 1]!, words[i + 2]!]) expect(c === 0x01000000 || c <= 0xffffff).toBe(true)
  }
  expect(await pane.find({ text: /\.-""/ })).toBeUndefined()
  await pane.unmount()
  const desktop = await $.ui.mount({ plugin: 'code-factory', surface: 'desktop', component: 'Pane', requestId: 'factory', props: { bodyColumns: 80 } } as never)
  expect({ raster: (await desktop.find({ type: 'Raster' })) !== undefined, svg: (await desktop.find({ type: 'Svg' })) !== undefined, art: (await desktop.find({ text: /\.-""\*""-\./ })) !== undefined, any: (await desktop.find({ text: /factory/ })) !== undefined }).toEqual({ raster: false, svg: true, art: false, any: true })
  await desktop.unmount()
})

test('motion off, the ascii tier and the classic look draw no Raster and start no timer', async ($, on) => {
  const blits = blitsOf($, on)
  const clock = fixture($, on, { store: { 'ui/theme': { name: 'hacker', motion: 'off' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const still = await mountPane($.ui, 80)
  expect(await still.find({ type: 'Raster' })).toBeUndefined()
  expect(await still.find({ text: /\.-""\*""-\./ })).toBeDefined()
  await still.unmount()
  await clock.advance(4000)
  expect(blits).toEqual([])
  expect(JSON.stringify(await $.command.run({ command: 'factory-theme', args: 'motion on ascii' } as never))).toContain('ascii glyphs')
  const ascii = await mountPane($.ui, 80)
  expect(await ascii.find({ type: 'Raster' })).toBeUndefined()
  await ascii.unmount()
  await clock.advance(4000)
  expect(blits).toEqual([])
  await $.command.run({ command: 'factory-theme', args: 'classic' } as never)
  await clock.advance(4000)
  expect(blits).toEqual([])
})

test('the face animates: frames are blitted to the pane, differ from one another and stop when the pane is gone', async ($, on) => {
  const blits = blitsOf($, on)
  const clock = fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const pane = await mountPane($.ui, 80)
  await clock.advance(2000)
  await clock.advance(3000)
  expect(blits.length).toBeGreaterThan(3)
  for (const b of blits) {
    expect([b.requestId, b.key]).toEqual(['factory', 'vox'])
    expect(unpackCells(b.cells)).toHaveLength(VOX_CELL_COLUMNS * VOX_CELL_ROWS * 3)
  }
  for (let i = 1; i < blits.length; i++) expect(blits[i]!.cells).not.toBe(blits[i - 1]!.cells)
  await pane.unmount()
})

test('a refused blit cancels the timer, and the next refresh starts it again', async ($, on) => {
  const blits = blitsOf($, on, () => ({ deny: 'not mounted' }))
  const clock = fixture($, on, { store: { 'ui/theme': { name: 'hacker' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  await clock.advance(500)
  expect(blits.length).toBe(1)
  await clock.advance(2000)
  expect(blits.length).toBe(1)
  await $.command.run({ command: 'factory-status' } as never)
  await clock.advance(1000)
  expect(blits.length).toBeGreaterThan(1)
})

const mountDesk = (ui: any, component: 'Pane' | 'AbovePrompt', bodyColumns = 100) => ui.mount({ plugin: 'code-factory', surface: 'desktop', component, ...(component === 'Pane' ? { requestId: 'factory' } : {}), props: { hasSurvey: false, bodyColumns } } as never)

test('the desktop pane under the hacker look is a dark console with a pipeline and the Vox drawing; the terminal pane has none of it', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker' } }, claudeTheme: 'light' })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const desk = await mountDesk($.ui, 'Pane')
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(2)
  expect(svgs.every((s: any) => typeof s.props.alt === 'string' && s.props.alt.length > 0 && s.props.isInteractive === true)).toBe(true)
  expect(svgs.some((s: any) => String(s.props.alt).startsWith('Pipeline:'))).toBe(true)
  expect((await desk.findAll({ type: 'Box' })).some((b: any) => b.props.backgroundColor === '#0B0F0C')).toBe(true)
  expect(await desk.find({ type: 'Box', key: 'T-002' })).toBeDefined()
  expect(svgs.find((s: any) => !String(s.props.alt).startsWith('Pipeline:'))?.props.source).toContain('prefers-reduced-motion')
  expect(JSON.stringify(await desk.findAll({ type: 'Svg' }))).not.toContain('<script')
  await desk.unmount()
  const term = await mountPane($.ui, 100)
  expect((await term.findAll({ type: 'Svg' })).length).toBe(0)
  expect((await term.findAll({ type: 'Box' })).some((b: any) => b.props.backgroundColor === '#0B0F0C')).toBe(false)
  await term.unmount()
})

test('the desktop pane under the classic look stays unfilled and has no Svg', async ($, on) => {
  fixture($, on)
  await $.command.run({ command: 'factory-status' } as never)
  const desk = await mountDesk($.ui, 'Pane')
  expect((await desk.findAll({ type: 'Svg' })).length).toBe(0)
  expect((await desk.findAll({ type: 'Box' })).some((b: any) => b.props.backgroundColor !== undefined)).toBe(false)
  await desk.unmount()
})

test('motion off draws the desktop Vox without an animation block', async ($, on) => {
  fixture($, on, { store: { 'ui/theme': { name: 'hacker', motion: 'off' } } })
  await $.command.run({ command: 'factory-status' } as never)
  await $.command.run({ command: 'factory-theme' } as never)
  const desk = await mountDesk($.ui, 'Pane')
  const vox = (await desk.findAll({ type: 'Svg' })).find((s: any) => !String(s.props.alt).startsWith('Pipeline:'))
  expect(vox?.props.source).toBeDefined()
  expect(String(vox?.props.source)).not.toContain('<style>')
  await desk.unmount()
})
