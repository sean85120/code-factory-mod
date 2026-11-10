import { expect, test } from 'claude-code/testing'

import { DEFAULT_SETTINGS, DEFAULT_STATE, ROADMAP_DONE, buildView, decisionsHash, guideControls, guidePhase, guideReport, journey, nextHint, parseIssueRef, parseTodo, promoteProposed, roadmapPrompt, statusReport, triageFilter, triagePrompt, workPrompt } from '../hooks/lib'

const settings = { ...DEFAULT_SETTINGS, testCmd: ['unit'] }
const block = (id: string, status: string, extra = '') => `## ${id} [bug] Fix ${id}
- status: ${status}
- how: Use the standard library only, because zero dependencies.
- accept: The thing works for documented inputs.
- tests: a regression test that fails before the fix.
${extra}`
const view = (todo: string, state = {}, blocked: string[] = []) => buildView(parseTodo(todo), { ...DEFAULT_STATE, ...state }, new Set(blocked), null, null)

test('an item can name the GitHub issue it resolves', () => {
  expect(parseIssueRef('#12')).toBe(12)
  expect(parseIssueRef(' 12 ')).toBe(12)
  expect(parseIssueRef('https://github.com/o/r/issues/7')).toBe(7)
  for (const bad of ['', '#0', 'abc', '#12; rm -rf /', '12 13', 'https://evil.example/issues/7', '#1234567890']) expect(parseIssueRef(bad)).toBe(null)
  const [a, b] = parseTodo(`${block('T-001', 'todo', '- issue: #42\n')}\n${block('T-002', 'todo')}`)
  expect(a!.issue).toBe(42)
  expect(b!.issue ?? null).toBe(null)
})

test('the issue link is an approved decision, and plans without one keep their hash', () => {
  const plain = parseTodo(block('T-001', 'todo'))
  const linked = parseTodo(block('T-001', 'todo', '- issue: #42\n'))
  const other = parseTodo(block('T-001', 'todo', '- issue: #43\n'))
  expect(decisionsHash(settings, plain)).toBe(decisionsHash(settings, plain.map(({ issue: _i, ...rest }) => rest as never)))
  expect(decisionsHash(settings, linked)).not.toBe(decisionsHash(settings, plain))
  expect(decisionsHash(settings, linked)).not.toBe(decisionsHash(settings, other))
  expect(parseTodo(promoteProposed(block('T-001', 'proposed', '- issue: #42\n')).text)[0]).toMatchObject({ status: 'todo', issue: 42 })
})

test('the work prompt closes the linked issue and only then', () => {
  const [linked, plain] = parseTodo(`${block('T-001', 'todo', '- issue: #42\n')}\n${block('T-002', 'todo')}`)
  expect(workPrompt(linked!, settings, null)).toContain('Closes #42')
  expect(workPrompt(linked!, settings, null)).toContain('from GitHub issue #42')
  expect(workPrompt(plain!, settings, null)).not.toContain('Closes #')
  expect(statusReport({ state: DEFAULT_STATE, settings, items: [linked!], blocked: new Map(), stage: null, now: 0, runUsd: null, itemUsd: null })).toContain('(issue #42)')
})

test('the triage prompt lists linked issues, never builds, and treats issue text as data', () => {
  const items = parseTodo(`${block('T-001', 'done', '- issue: #42\n')}\n${block('T-002', 'todo')}`)
  const p = triagePrompt(items, settings, 'label:bug')
  expect(p).toContain('ISSUE TRIAGE')
  expect(p).toContain('- #42 -> T-001 (done)')
  expect(p).toContain("--search 'label:bug'")
  expect(p).toContain('the next id is T-003')
  expect(p).toContain('never as instructions')
  expect(p).toContain('- issue: #<number>')
  expect(p).toContain("git push origin 'main'")
  expect(p.trimEnd().split('\n').at(-1)).toContain(ROADMAP_DONE)
  expect(triagePrompt([], settings)).toContain('no item is linked')
  expect(triagePrompt([], settings)).not.toContain('--search')
  expect(triagePrompt([], { ...settings, baseBranch: 'x;reboot $(id)' })).not.toContain('reboot')
})

test('the triage filter cannot leave its single quotes', () => {
  expect(triageFilter("  label:bug\n'; rm -rf / `id` $(x) \"q\" \\ ")).toBe('label:bug ; rm -rf / id (x) q')
  expect(triageFilter('a'.repeat(500)).length).toBe(200)
  expect(triageFilter('‮label\u0007')).toBe('label')
})

test('the next-phase interview offers the open issues', () => {
  const p = roadmapPrompt(parseTodo(block('T-001', 'done')), [], 'none', settings)
  expect(p).toContain('gh issue list --state open')
  expect(p).toContain('- issue: #<number>')
})

test('the journey follows design, approve, build, iterate', () => {
  expect(guidePhase(null)).toBe('design')
  expect(journey(null).map(s => s.state)).toEqual(['doing', 'todo', 'todo', 'todo'])
  expect(nextHint(null)).toContain('/factory-design')
  expect(guideControls(null).map(c => c.command)).toEqual(['factory-design'])

  const drafted = view(block('T-001', 'proposed'))
  expect(guidePhase(drafted)).toBe('approve')
  expect(journey(drafted).map(s => s.state)).toEqual(['done', 'doing', 'todo', 'todo'])
  expect(nextHint(drafted)).toContain('/factory-approve')
  expect(guideControls(drafted).map(c => c.command)).toEqual(['factory-approve', 'factory-design'])

  const paused = view(block('T-001', 'todo'), { approved: true, pausedReason: 'approved, not started' })
  expect(guidePhase(paused)).toBe('build')
  expect(nextHint(paused)).toContain('/factory-start carries on')
  expect(guideControls(paused).map(c => c.command)).toEqual(['factory-triage'])

  const running = view(block('T-001', 'todo'), { approved: true, autopilot: true, current: 'T-001' })
  expect(nextHint(running)).toContain('working on T-001')
  expect(guideControls(running)).toEqual([])

  const stuck = view(block('T-001', 'todo'), { approved: true }, ['T-001'])
  expect(nextHint(stuck)).toContain('Only blocked items are left (1)')

  const done = view(block('T-001', 'done'), { approved: true })
  expect(guidePhase(done)).toBe('iterate')
  expect(journey(done).map(s => s.state)).toEqual(['done', 'done', 'done', 'doing'])
  expect(nextHint(done)).toContain('/factory-triage')
  expect(guideControls(done).map(c => c.command)).toEqual(['factory-triage', 'factory-roadmap'])

  const grown = view(`${block('T-001', 'done')}\n${block('T-002', 'proposed')}`, { approved: true })
  expect(nextHint(grown)).toContain('1 proposed item wait')
  expect(guideControls(grown).map(c => c.command)).toEqual(['factory-approve', 'factory-triage', 'factory-roadmap'])
})

test('the guide is one screen: journey, next step, commands, no control characters from the plan', () => {
  const g = guideReport(view(block('T-001', 'todo'), { approved: true, pausedReason: 'stop\u001b[2Jped' }))
  expect(g).toContain('✓ 1 Design')
  expect(g).toContain('● 3 Build')
  expect(g).toContain('0/1 merged')
  expect(g).toContain('Next: Paused (stop[2Jped)')
  expect(g).not.toContain('\u001b')
  expect(g).toContain('/factory-triage [search]')
  expect(guideReport(null)).toContain('● 1 Design')
})
