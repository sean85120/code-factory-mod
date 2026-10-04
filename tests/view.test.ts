import { expect, mock, test } from 'claude-code/testing'

import { DEFAULT_STATE, branchFor, buildView, classifyBash, decisionsHash, loopEventForBash, parseSettings, parseTodo, reviewAgentPrompt, stageAfter } from '../hooks/lib'

const TODO = `## T-001 [feature] First
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The first thing works for documented inputs.
- tests: Unit tests for each input.

## T-002 [bug] Second
- status: done
- how: Use the standard library only, because zero dependencies.
- accept: The second thing works for documented inputs.
- tests: Unit tests for each input.

## T-003 [chore] Third
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The third thing works for documented inputs.
- tests: Unit tests for each input.
`

test('rows hide done items, mark the current one and the blocked one', () => {
  const items = parseTodo(TODO)
  const v = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-001' }, new Set(['T-003']), null, null)
  expect(v.doneCount).toBe(1)
  expect(v.rows.map(r => `${r.id}:${r.mark}`)).toEqual(['T-001:doing', 'T-003:blocked'])
  expect(v.stage).toBe('build')
})

test('changes list what moved since the last view, newest three kept', () => {
  const items = parseTodo(TODO)
  const a = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-001' }, new Set(), null, null)
  const b = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-003' }, new Set(), null, { ...a, stage: 'CI' })
  expect(b.changes).toEqual(['T-001 doing -> todo', 'T-003 todo -> doing'])
  expect(b.stage).toBe('build')
  const c = buildView(items, { ...DEFAULT_STATE, approved: true, autopilot: true, current: 'T-003' }, new Set(), null, { ...b, stage: 'CI' })
  expect(c.stage).toBe('CI')
  expect(c.changes).toEqual(b.changes)
})

test('shell commands map to loop stages', () => {
  const ev = (cmd: string) => loopEventForBash(classifyBash(cmd, 'main', 'factory/t-001-x'))
  expect(ev('git commit -m x')).toBe('commit')
  expect(ev('gh pr create --base main --title t --body b')).toBe('pr')
  expect(ev('gh pr merge 3 --squash')).toBe('merge')
  expect(ev('ls -la')).toBeNull()
  expect(stageAfter('pr')).toBe('CI')
  expect(stageAfter('reviewed')).toBe('PR')
})

const SHA = 'abc1234def5678abc1234def5678abc1234def56'

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function fixture($: any, on: any, toolIsError = false, branch = 'factory/t-001-first', agentText = ''): void {
  mock.clock(on, { now: 1_000_000 })
  const settings = JSON.stringify({ testCmd: ['unit'], baseBranch: 'main', requireReview: false, requireTestChanges: false, allowTestRemoval: true })
  const hash = decisionsHash(parseSettings(settings).settings, parseTodo(TODO))
  const files: Record<string, string> = {
    '.factory/settings.json': settings,
    '.factory/todo.md': TODO,
    '.factory/state.json': JSON.stringify({ approved: true, approvedHash: hash, autopilot: true, current: 'T-001', approvedDone: ['T-002'], review: { sha: SHA, danger: 0, medium: 0 } }),
  }
  const key = (path: string) => Object.keys(files).find(k => path.endsWith(`/${k}`))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: key(e.path) !== undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files[key(e.path) ?? ''] ?? '' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const cmd = e.argv.join(' ')
    if (cmd.startsWith('git branch')) return { value: ok(`${branch}\n`) }
    if (cmd.startsWith('git rev-parse')) return { value: ok(`${SHA}\n`) }
    return { value: ok('') }
  })
  on('tool.call', (_: unknown, e: { tool: string; prompt?: string }) =>
    e.tool === 'Agent'
      ? { result: { content: [{ type: 'text', text: agentText }] }, text: 'agent', isError: false }
      : { result: 'ran', text: 'ran', isError: toolIsError },
  )
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'base' }))
}

async function stageIs($: any, stage: string): Promise<boolean> {
  const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  const found = await ui.find({ type: 'Text', text: new RegExp(`● ${stage}`) })
  await ui.unmount()
  return found !== undefined
}

test('the band shows stage pipeline, todo rows and the change log', async ($, on) => {
  fixture($, on)
  await $.command.run({ command: 'factory-status' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'code-factory', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as never)
    expect(await ui.find({ type: 'Text', text: /T-001/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /T-003/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an allowed gh pr create moves the band to CI', async ($, on) => {
  fixture($, on)
  await $.command.run({ command: 'factory-status' } as never)
  expect(await stageIs($, 'build')).toBe(true)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title t --body b' })
  expect(await stageIs($, 'CI')).toBe(true)
})

test('a denied command keeps its deny and leaves the stage alone', async ($, on) => {
  fixture($, on, false, 'main')
  await $.command.run({ command: 'factory-status' } as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title t --body b' })
  expect(JSON.stringify(r)).toContain('open PRs from a factory/* branch')
  expect(await stageIs($, 'build')).toBe(true)
})

test('a command that errored does not advance the stage', async ($, on) => {
  fixture($, on, true)
  await $.command.run({ command: 'factory-status' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title t --body b' })
  expect(await stageIs($, 'build')).toBe(true)
})

const spawnReview = ($: any) =>
  $.tool.call({
    tool: 'Agent',
    description: 'review',
    prompt: reviewAgentPrompt(parseSettings(JSON.stringify({ testCmd: ['unit'], baseBranch: 'main', requireReview: false, requireTestChanges: false, allowTestRemoval: true })).settings, branchFor({ id: 'T-001', title: 'First' })),
    subagent_type: 'general-purpose',
  })

test('a clean review moves the band to PR', async ($, on) => {
  fixture($, on, false, 'factory/t-001-first', `ok\nFACTORY-REVIEW: danger=0 medium=0 sha=${SHA}`)
  await $.command.run({ command: 'factory-status' } as never)
  await spawnReview($)
  expect(await stageIs($, 'PR')).toBe(true)
})

test('a review with findings sends the band back to build', async ($, on) => {
  fixture($, on, false, 'factory/t-001-first', `no\nFACTORY-REVIEW: danger=1 medium=0 sha=${SHA}`)
  await $.command.run({ command: 'factory-status' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title t --body b' })
  expect(await stageIs($, 'CI')).toBe(true)
  await spawnReview($)
  expect(await stageIs($, 'build')).toBe(true)
})

test('a commit after the PR moves the band back to build', async ($, on) => {
  fixture($, on)
  await $.command.run({ command: 'factory-status' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title t --body b' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m again' })
  expect(await stageIs($, 'build')).toBe(true)
})
