import { expect, mock, test } from 'claude-code/testing'

import { ROADMAP_CEILING_MS, ROADMAP_DONE, ROADMAP_IDLE_MS, ROADMAP_MAX_TURNS, branchFor, decisionsHash, parseSettings, parseTodo, reviewAgentPrompt } from '../hooks/lib'

const TODO = `## T-001 [chore] First
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The first thing works for documented inputs.
- tests: none needed for a chore.

## T-002 [chore] Second
- status: todo
- how: Use the standard library only, because zero dependencies.
- accept: The second thing works for documented inputs.
- tests: none needed for a chore.
`
const SHA = 'abc1234def5678abc1234def5678abc1234def56'
const ID = 'a4d789fa45ad6c140'
const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const usage = (model: string, n: number) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model })

type Opts = { state?: Record<string, unknown>; settings?: Record<string, unknown>; todo?: string; merged?: string[]; branch?: string; agentText?: string; lockedBy?: string; noCost?: boolean; storeSetFails?: boolean; hook?: (what: string) => Promise<unknown> | unknown; store?: Record<string, unknown>; read?: (path: string, files: Record<string, string>) => string | undefined; bashText?: string; files?: Record<string, string>; storeRef?: Record<string, unknown> }

function setup($: any, on: any, o: Opts = {}) {
  const settingsRaw = { testCmd: ['unit'], baseBranch: 'main', requireReview: false, contextReset: 'none', ...o.settings }
  const settingsText = JSON.stringify(settingsRaw)
  const todo = o.todo ?? TODO
  const hash = decisionsHash(parseSettings(settingsText).settings, parseTodo(todo))
  const files: Record<string, string> = {
    '.factory/settings.json': settingsText,
    '.factory/todo.md': todo,
    '.factory/state.json': JSON.stringify({ approved: true, approvedHash: hash, autopilot: false, current: null, ...o.state }),
  }
  Object.assign(files, o.files)
  if (o.lockedBy) files['.factory/lock.json'] = JSON.stringify({ owner: o.lockedBy, heartbeat: 1_000_000 })
  const live = { usd: 0, noCost: o.noCost === true, submitted: [] as string[], ran: [] as string[] }
  const key = (path: string) => Object.keys(files).find(k => path.endsWith(`/${k}`) || path === k)
  if (o.storeSetFails) {
    const mem: Record<string, unknown> = { ...o.store }
    on('store.get', (_: unknown, e: { key: string }) => ({ value: mem[e.key] }))
    on('store.keys', () => ({ value: Object.keys(mem) }))
    on('store.delete', (_: unknown, e: { key: string }) => {
      delete mem[e.key]
      return { value: undefined }
    })
    on('store.set', () => {
      throw new Error('disk full')
    })
  } else if (o.storeRef) {
    const mem = o.storeRef
    on('store.get', (_: unknown, e: { key: string }) => ({ value: mem[e.key] }))
    on('store.keys', () => ({ value: Object.keys(mem) }))
    on('store.delete', (_: unknown, e: { key: string }) => {
      delete mem[e.key]
      return { value: undefined }
    })
    on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
      mem[e.key] = JSON.parse(JSON.stringify(e.value))
      return { value: undefined }
    })
  } else mock.store(on, o.store)
  on('session.usage', async () => {
    await o.hook?.('usage')
    return { value: { startedAt: 0, context: {}, rateLimits: [], ...(live.noCost ? {} : { cost: { usd: live.usd } }) } }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work/widget' }))
  on('fs.exists', async (_: unknown, e: { path: string }) => {
    await o.hook?.(`exists:${e.path}`)
    return { value: key(e.path) !== undefined || Object.keys(files).some(k => k.startsWith(`${e.path.replace(/^.*\/\.factory\//, '.factory/')}/`)) }
  })
  on('fs.read', async (_: unknown, e: { path: string }) => {
    await o.hook?.(`read:${e.path}`)
    return { value: o.read?.(e.path, files) ?? files[key(e.path) ?? ''] ?? '' }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    const dir = `${e.path.replace(/^.*\/\.factory\//, '.factory/').replace(/\/$/, '')}/`
    return { value: Object.keys(files).filter(k => k.startsWith(dir)).map(k => ({ name: k.slice(dir.length), kind: 'file' })) }
  })
  on('fs.write', async (_: unknown, e: { path: string; text: string }) => {
    await o.hook?.(`prewrite:${e.path}`)
    files[key(e.path) ?? e.path.replace(/^.*\/\.factory\//, '.factory/')] = e.text
    await o.hook?.(`write:${e.path}`)
    return { value: undefined }
  })
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const cmd = e.argv.join(' ')
    live.ran.push(cmd)
    const forced = (await o.hook?.(cmd)) as { exitCode: number } | undefined
    if (forced && typeof forced === 'object' && 'exitCode' in forced) return { value: { stdout: '', stderr: 'forced', isStdoutTruncated: false, isStderrTruncated: false, ...forced } }
    if (e.argv[0] === 'rm') {
      const k = key(e.argv[e.argv.length - 1]!)
      if (k) delete files[k]
      return { value: ok('') }
    }
    if (cmd.startsWith('git remote get-url')) return { value: ok('git@github.com:acme/widget.git\n') }
    if (cmd.startsWith('git branch')) return { value: ok(`${o.branch ?? 'main'}\n`) }
    if (cmd.startsWith('git rev-parse')) return { value: ok(`${SHA}\n`) }
    if (cmd.startsWith('git show origin/')) return { value: ok(files[cmd.replace(/^.*:\.\//, '')] ?? '') }
    if (cmd.startsWith('gh pr list')) return { value: ok(JSON.stringify((o.merged ?? []).map(id => ({ number: 3, headRefName: `factory/${id.toLowerCase()}-x` })))) }
    if (cmd.startsWith('gh pr create')) return { value: ok('https://github.com/acme/widget/pull/31\n') }
    return { value: ok('') }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    live.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_: unknown, e: { tool: string }) =>
    e.tool === 'Agent'
      ? { result: { content: [{ type: 'text', text: o.agentText ?? '' }] }, text: 'agent', isError: false }
      : e.tool === 'Bash'
        ? { result: o.bashText ?? 'https://github.com/acme/widget/pull/31', text: o.bashText ?? 'https://github.com/acme/widget/pull/31', isError: false }
        : { result: 'ran', text: 'ran', isError: false },
  )
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'base' }))
  return { files, live, state: () => JSON.parse(files['.factory/state.json']!) }
}

const mainTurn = ($: any, over: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...over })

const composeInput = { model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const instructionsOf = async ($: any): Promise<string> =>
  ((await $.prompt.compose(composeInput as never)).sections.find((s: { id: string }) => s.id === 'code-factory:instructions')?.text as string | undefined) ?? ''

test('a factory turn is charged to its item by the session cost counter, with its tokens by model and phase', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(fx.live.submitted.some(s => s.startsWith('CODE FACTORY: work item T-001'))).toBe(true)
  fx.live.usd = 1.75
  await mainTurn($, { usage: usage('claude-opus-4-1', 500) })
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toContain('all repos: $0.75')
  expect(report).toContain('acme/widget (this repo): $0.75 over 1 item(s)')
  expect(report).toMatch(/T-001\s+\$0\.75\s+100%\s+1/)
  expect(report).toContain('opus-4-1 1.0k (out 500)')
  expect(report).toContain('build 100%')
  expect(report).toContain('last run: $0.75')
})

test("a pause mid-turn still charges the rest of that turn, but never the person's own turns after it", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await $.command.run({ command: 'factory-pause' } as never)
  fx.live.usd = 9
  await mainTurn($, { usage: usage('claude-sonnet-4-5', 100) })
  await $.prompt.submit({ text: 'something of my own', origin: { kind: 'composer' } } as never)
  fx.live.usd = 12
  await mainTurn($, { usage: usage('claude-opus-4-1', 500) })
  fx.live.usd = 15
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const report = (await $.command.run({ command: 'factory-costs', args: 'widget' } as never)).text
  expect(report).toContain('acme/widget (this repo): $8.00')
  expect(report).toContain('sonnet-4-5 200')
  expect(report).not.toContain('opus-4-1')
})

test('/factory-stop mid-turn also keeps charging that turn until it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  await $.command.run({ command: 'factory-stop' } as never)
  fx.live.usd = 4
  await mainTurn($, { usage: usage('claude-sonnet-4-5', 10) })
  fx.live.usd = 6
  await mainTurn($)
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toMatch(/T-001\s+\$3\.00/)
  expect(report).toContain('sonnet-4-5 20')
})

test('a prompt the person types during a design-class turn ends its charge there', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-design', args: '' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.2
  await $.prompt.submit({ text: 'my own question', origin: { kind: 'composer' } } as never)
  fx.live.usd = 5
  await mainTurn($)
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toMatch(/\(plan\)\s+\$0\.20/)
})

test('/factory-stop ends the charge too, so later turns of the person are not billed to the item', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await $.command.run({ command: 'factory-stop' } as never)
  fx.live.usd = 8
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toMatch(/T-001\s+\$0\.50/)
  expect(fx.state().events.some((e: { kind: string; detail: string }) => e.kind === 'paused' && e.detail === 'stopped by you')).toBe(true)
})

test('without a cost ledger no dollars are shown, tokens are still recorded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { noCost: true })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  await mainTurn($, { usage: usage('claude-opus-4-1', 50) })
  expect((await $.command.run({ command: 'factory-status' } as never)).text).not.toContain('This run')
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toMatch(/T-001\s+\$0\.00/)
  expect(report).toContain('opus-4-1 100')
  expect(fx.state().autopilot).toBe(true)
})

test('a write from a stale snapshot keeps events another hook logged meanwhile', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let reads = 0
  let stale = ''
  const fx = setup($, on, {
    state: { autopilot: true, current: 'T-001' },
    read: (path, files) => {
      if (!path.endsWith('.factory/state.json')) return undefined
      reads++
      if (reads === 1) {
        stale = files['.factory/state.json']!
        files['.factory/state.json'] = JSON.stringify({ ...JSON.parse(stale), events: [{ ts: 999_000, itemId: 'T-001', kind: 'commit', detail: 'logged meanwhile' }] })
        return stale
      }
      return undefined
    },
  })
  await $.command.run({ command: 'factory-pause' } as never)
  const kinds = fx.state().events.map((e: { kind: string }) => e.kind)
  expect(kinds).toEqual(['commit', 'paused'])
  expect(fx.state().autopilot).toBe(false)
})

test('a pause from a stale snapshot keeps the review fields another hook wrote meanwhile', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let reads = 0
  const review = { review: { sha: SHA, danger: 0, medium: 1 }, reviewRounds: 3, reviewAgentId: ID, reviewAgentAt: 999_500, reviewWaitMs: 1_800_000 }
  const fx = setup($, on, {
    state: { autopilot: true, current: 'T-001' },
    read: (path, files) => {
      if (!path.endsWith('.factory/state.json')) return undefined
      reads++
      if (reads === 1) {
        const stale = files['.factory/state.json']!
        files['.factory/state.json'] = JSON.stringify({ ...JSON.parse(stale), ...review })
        return stale
      }
      return undefined
    },
  })
  await $.command.run({ command: 'factory-pause' } as never)
  const saved = fx.state()
  expect(saved.autopilot).toBe(false)
  expect(saved.review).toEqual(review.review)
  expect(saved.reviewRounds).toBe(3)
  expect(saved.reviewAgentId).toBe(ID)
  expect(saved.reviewAgentAt).toBe(999_500)
  expect(saved.reviewWaitMs).toBe(1_800_000)
})

test('the loop pauses once a run reaches budgetUsd, and does not start more work', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { budgetUsd: 0.5 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const sent = fx.live.submitted.length
  fx.live.usd = 1.6
  await mainTurn($)
  expect(fx.state().autopilot).toBe(false)
  await clock.advance(5000)
  expect(fx.state().pausedReason).toContain('budget reached: this run spent $0.60 of the $0.50 budget')
  expect(fx.live.submitted.length).toBe(sent)
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(true)
})

test('advance() checks the budget, unsettled spend included, before it hands out more work', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { budgetUsd: 0.5 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.3
  await mainTurn($)
  expect(fx.state().autopilot).toBe(true)
  const sent = fx.live.submitted.length
  fx.live.usd = 3
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('budget reached: this run spent $2.00')
  expect(fx.live.submitted.length).toBe(sent)
})

test('reviewer turns are counted as review tokens of the current item', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: true, current: 'T-001' }, branch: 'factory/t-001-first', agentText: `Async agent launched successfully.\nagentId: ${ID}` })
  fx.live.usd = 2
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Agent', description: 'review', prompt: reviewAgentPrompt(parseSettings(fx.files['.factory/settings.json']!).settings, branchFor({ id: 'T-001', title: 'First' })), subagent_type: 'general-purpose' })
  await mainTurn($)
  fx.live.usd = 2.4
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}`, usage: usage('claude-sonnet-4-5', 200) })
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toMatch(/T-001\s+\$0\.40/)
  expect(report).toContain('sonnet-4-5 400')
  expect(report).toContain('review 100%')
  const kinds = fx.state().events.map((e: { kind: string }) => e.kind)
  expect(kinds).toContain('review-launched')
  expect(kinds).toContain('review-verdict')
})

test('commits, PRs and verdicts land in the timeline; /factory-log prints it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: true, current: 'T-001' }, branch: 'factory/t-001-first' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "T-001: do it"' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title t --body b' })
  const events = fx.state().events
  expect(events.map((e: { kind: string }) => e.kind)).toEqual(['commit', 'pr-opened'])
  expect(events[0].detail).toBe('T-001: do it')
  expect(events[1].pr).toBe(31)
  const log = (await $.command.run({ command: 'factory-log', args: 'T-001' } as never)).text
  expect(log).toContain('commit')
  expect(log).toContain('#31 https://github.com/acme/widget/pull/31')
  const status = (await $.command.run({ command: 'factory-status' } as never)).text
  expect(status).toContain('PR #31 https://github.com/acme/widget/pull/31')
  expect((await $.command.run({ command: 'factory-log', args: 'junk' } as never)).text).toContain('Usage')
})

test('nothing is logged while the loop is not live, and the model cannot write the timeline', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: false, current: 'T-001' }, branch: 'factory/t-001-first' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(fx.state().events ?? []).toEqual([])
  const r = await $.tool.call({ tool: 'Bash', command: `python3 -c "open('.factory/state.json','w').write('{}')"` })
  expect(JSON.stringify(r)).toContain('controlled by the person')
})

test('/factory-pause stops after the turn and keeps the item, its attempts and review rounds', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: true, current: 'T-001', attempts: 2, reviewRounds: 1 } })
  const r = await $.command.run({ command: 'factory-pause' } as never)
  expect(r.text).toContain('Factory paused')
  const s = fx.state()
  expect(s.autopilot).toBe(false)
  expect(s.current).toBe('T-001')
  expect(s.attempts).toBe(2)
  expect(s.reviewRounds).toBe(1)
  expect(s.pausedReason).toContain('paused by you')
  expect(s.events.at(-1).kind).toBe('paused')
  expect((await $.command.run({ command: 'factory-pause' } as never)).text).toContain('not running')
})

test('/factory-skip blocks the item with a note so the loop moves on; /factory-retry makes it eligible again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  const skip = await $.command.run({ command: 'factory-skip', args: 't-001 needs a product call' } as never)
  expect(skip.text).toContain('T-001 skipped')
  expect(fx.files['.factory/blocked/T-001.md']).toContain('Skipped by you: needs a product call')
  expect((await $.command.run({ command: 'factory-status' } as never)).text).toContain('- T-001: Skipped by you: needs a product call')
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(fx.live.submitted.some(s => s.startsWith('CODE FACTORY: work item T-002'))).toBe(true)
  const retry = await $.command.run({ command: 'factory-retry', args: 'T-001' } as never)
  expect(retry.text).toContain('T-001 is eligible again')
  expect(fx.files['.factory/blocked/T-001.md']).toBeUndefined()
  expect(fx.state().events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['skip', 'started', 'retry']))
  expect(fx.files['.factory/todo.md']).toBe(TODO)
})

test('/factory-retry resets the attempts of the current item, never flips done or bypasses approval', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { current: 'T-001', attempts: 4, reviewRounds: 3 } })
  fx.files['.factory/blocked/T-001.md'] = 'Blocked by the factory after 4 attempts.\n'
  await $.command.run({ command: 'factory-retry', args: 'T-001' } as never)
  expect(fx.state().attempts).toBe(0)
  expect(fx.state().reviewRounds).toBe(0)
  expect(fx.files['.factory/todo.md']).toBe(TODO)
  expect((await $.command.run({ command: 'factory-retry', args: 'T-002' } as never)).text).toContain('not blocked')
  expect((await $.command.run({ command: 'factory-retry', args: '' } as never)).text).toContain('Usage')
  expect((await $.command.run({ command: 'factory-retry', args: 'T-404' } as never)).text).toContain('not an item')
})

test('/factory-retry refuses a done item, a changed plan, and another session holding the lock', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const done = setup($, on, { todo: TODO.replace('status: todo', 'status: done'), state: { approvedDone: ['T-001'] } })
  done.files['.factory/blocked/T-001.md'] = 'x\n'
  expect((await $.command.run({ command: 'factory-retry', args: 'T-001' } as never)).text).toContain('already done')
  done.files['.factory/todo.md'] = TODO.replace('Use the standard', 'Use a different')
  expect((await $.command.run({ command: 'factory-retry', args: 'T-001' } as never)).text).toContain('changed since approval')
  expect(done.files['.factory/blocked/T-001.md']).toBe('x\n')
})

test('/factory-skip refuses a done item', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: TODO.replace('status: todo', 'status: done'), state: { approvedDone: ['T-001'] } })
  expect((await $.command.run({ command: 'factory-skip', args: 'T-001' } as never)).text).toContain('already done')
  expect(fx.files['.factory/blocked/T-001.md']).toBeUndefined()
})

test('/factory-skip refuses an already blocked item and keeps its note', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { files: { '.factory/blocked/T-001.md': 'Blocked by the factory after 3 attempts.\n' } })
  expect((await $.command.run({ command: 'factory-skip', args: 'T-001 new reason' } as never)).text).toContain('already blocked')
  expect(fx.files['.factory/blocked/T-001.md']).toBe('Blocked by the factory after 3 attempts.\n')
})

test('/factory-retry refuses a proposed item and an over-long argument is refused', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: TODO.replace('status: todo', 'status: proposed') })
  expect((await $.command.run({ command: 'factory-retry', args: 'T-001' } as never)).text).toContain('still proposed')
  expect((await $.command.run({ command: 'factory-skip', args: `T-001 ${'x'.repeat(2500)}` } as never)).text).toContain('Usage')
  expect(fx.files['.factory/blocked/T-001.md']).toBeUndefined()
})

test('skip and retry refuse while another session runs the loop', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { lockedBy: 'someone-else' })
  expect((await $.command.run({ command: 'factory-skip', args: 'T-001' } as never)).text).toContain('another session')
  expect((await $.command.run({ command: 'factory-retry', args: 'T-001' } as never)).text).toContain('another session')
  expect((await $.command.run({ command: 'factory-roadmap' } as never)).text).toContain('another session')
})

test('/factory-costs reset needs the exact repo key', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 2
  await mainTurn($)
  expect((await $.command.run({ command: 'factory-costs', args: 'reset widget' } as never)).text).toContain('exact repo key: acme/widget')
  expect((await $.command.run({ command: 'factory-costs', args: 'all' } as never)).text).toContain('$1.00')
  await $.command.run({ command: 'factory-stop' } as never)
  await mainTurn($)
  expect((await $.command.run({ command: 'factory-costs', args: 'reset acme/widget' } as never)).text).toContain('deleted')
  expect((await $.command.run({ command: 'factory-costs', args: '' } as never)).text).toContain('No factory costs recorded yet')
})

const DONE_TODO = TODO.replace(/status: todo/g, 'status: done')

test('when the plan is fully done the factory asks once for the next phase, as a design-class turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, state: { autopilot: true, current: 'T-002', approvedDone: ['T-001'] }, merged: ['T-002'] })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(2000)
  const s = fx.state()
  expect(s.autopilot).toBe(false)
  expect(s.roadmapAsked).toBe(true)
  expect(s.pausedReason).toBe('nothing left to do')
  const asked = fx.live.submitted.filter(t => t.includes('next-phase interview'))
  expect(asked.length).toBe(1)
  const text = await instructionsOf($)
  expect(text).toContain('NEXT-PHASE INTERVIEW')
  expect(text).toContain('the next id is T-003')
  expect(text).toContain('T-002 [chore] Second (PR merged by the factory)')
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Plan the next phase" -- .factory/todo.md' })
  expect(JSON.stringify(commit)).toContain('do not commit on main')
  await mainTurn($)
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  fx.files['.factory/state.json'] = JSON.stringify({ ...fx.state(), autopilot: true })
  await clock.advance(400_000)
  expect(fx.live.submitted.filter(t => t.includes('next-phase interview')).length).toBe(1)
})

test('askNextPhase false, an unfinished plan, or an earlier ask means no interview', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, settings: { askNextPhase: false }, state: { autopilot: true, current: 'T-002', approvedDone: ['T-001'] }, merged: ['T-002'] })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(2000)
  expect(fx.state().pausedReason).toBe('nothing left to do')
  expect(fx.live.submitted.some(t => t.includes('next-phase interview'))).toBe(false)
  expect(fx.state().roadmapAsked).toBe(false)
})

test('a blocked item left over means the plan is not done, so no interview', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: true, current: 'T-002', approvedDone: ['T-001'] }, todo: TODO.replace('status: todo', 'status: done').replace(/(## T-002[\s\S]*?)status: todo/, '$1status: done'), merged: ['T-002'] })
  fx.files['.factory/todo.md'] = DONE_TODO.replace('## T-002', '## T-003 [chore] Third\n- status: todo\n- how: Use the standard library only, because zero dependencies.\n- accept: The third thing works for documented inputs.\n- tests: none needed for a chore.\n\n## T-002')
  fx.files['.factory/blocked/T-003.md'] = 'stuck\n'
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(2000)
  expect(fx.live.submitted.some(t => t.includes('next-phase interview'))).toBe(false)
})

test('/factory-roadmap starts the interview only when nothing is runnable; approve resets the marker', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const busy = setup($, on)
  expect((await $.command.run({ command: 'factory-roadmap' } as never)).text).toContain('still has runnable work')
  busy.files['.factory/todo.md'] = DONE_TODO
  busy.files['.factory/state.json'] = JSON.stringify({ ...busy.state(), approvedHash: decisionsHash(parseSettings(busy.files['.factory/settings.json']!).settings, parseTodo(DONE_TODO)), approvedDone: ['T-001', 'T-002'] })
  const r = await $.command.run({ command: 'factory-roadmap' } as never)
  expect(r.text).toContain('next-phase interview starting')
  await clock.advance(1000)
  expect(busy.state().roadmapAsked).toBe(true)
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  busy.files['.factory/design.md'] = '# Design\n\n## Decisions\n- x\n'
  const approved = await $.command.run({ command: 'factory-approve' } as never)
  expect(approved.text).toContain('Approved')
  expect(busy.state().roadmapAsked).toBe(false)
  expect(await instructionsOf($)).toBe('')
})

test('/factory-roadmap refuses an unapproved plan', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { state: { approved: false } })
  expect((await $.command.run({ command: 'factory-roadmap' } as never)).text).toContain('not approved')
})

test('the band shows the run spend and the latest timeline events', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { budgetUsd: 20 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 2.25
  await $.command.run({ command: 'factory-status' } as never)
  const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  expect(await ui.find({ type: 'Text', text: /\$1\.25\/\$20\.00 .* · item \$1\.25/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /T-001 started/ })).toBeDefined()
  await ui.unmount()
})

async function autoRoadmap($: any, on: any, o: Opts = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, state: { autopilot: true, current: 'T-002', approvedDone: ['T-001'] }, merged: ['T-002'], ...o })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(2000)
  expect(fx.live.submitted.filter(t => t.includes('next-phase interview')).length).toBe(1)
  return { fx, clock }
}
const bash = async ($: any, command: string) => JSON.stringify(await $.tool.call({ tool: 'Bash', command }))

test('the auto-launched interview is fully armed: no commit or push to the base branch, design files included', async ($, on) => {
  await autoRoadmap($, on)
  expect(await bash($, 'git add .factory/todo.md && git commit -m "Plan" -- .factory/todo.md')).toContain('do not commit on main')
  expect(await bash($, 'git push origin main')).toContain('never push to main')
  expect(await bash($, 'git push origin HEAD:main')).toContain('never push to main')
  expect(await bash($, 'git push --force origin x')).toContain('force-push')
  expect(await bash($, 'gh api -X PUT repos/o/r/pulls/3/merge')).toContain('gh api')
  expect(await bash($, 'gh pr merge 3 --squash')).toContain('code-factory')
  expect(JSON.stringify(await $.tool.call({ tool: 'Write', file_path: '/repo/.claude/settings.json', content: 'x' } as never))).toContain('under .claude')
  expect(JSON.stringify(await $.tool.call({ tool: 'Write', file_path: '/repo/.factory/todo.md', content: 'x' } as never))).not.toContain('code-factory')
})

test('the interview guards are disarmed once its turn ends', async ($, on) => {
  await autoRoadmap($, on)
  expect(await bash($, 'git commit -m code')).toContain('do not commit on main')
  await mainTurn($)
  expect(await bash($, 'git commit -m code')).not.toContain('code-factory')
})

test('the interview guards are disarmed when the turn outlives the time limit', async ($, on) => {
  const { clock } = await autoRoadmap($, on)
  expect(await bash($, 'git commit -m code')).toContain('do not commit on main')
  await clock.advance(3 * 3600000 + 600000)
  expect(await bash($, 'git commit -m code')).not.toContain('code-factory')
})

test('/factory-roadmap run by the person is armed until the person replies; the first typed reply disarms it by design, as in /factory-design (accepted limit)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  setup($, on, { todo: DONE_TODO, state: { approvedDone: ['T-001', 'T-002'] } })
  await $.command.run({ command: 'factory-roadmap' } as never)
  await clock.advance(1000)
  expect(await bash($, 'git commit -m y -- .factory/todo.md')).toContain('do not commit on main')
  expect(await bash($, 'git push origin main')).toContain('never push to main')
  await $.prompt.submit({ text: 'my answer', origin: { kind: 'composer' } } as never)
  expect(await bash($, 'git commit -m y -- .factory/todo.md')).not.toContain('code-factory')
})

test('with a budget set and no readable spend the loop pauses and says why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { noCost: true, settings: { budgetUsd: 5 } })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('cannot be read')
  expect(fx.live.submitted.some(t => t.startsWith('CODE FACTORY: work item'))).toBe(false)
  expect((await $.command.run({ command: 'factory-status' } as never)).text).toContain('budget cannot be enforced')
})

test('one unreadable cost read right after a turn does not pause a budgeted loop, two in a row do', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { budgetUsd: 5 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.noCost = true
  await mainTurn($)
  expect(fx.state().autopilot).toBe(true)
  fx.live.noCost = false
  fx.live.usd = 2
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(true)
  fx.live.noCost = true
  await mainTurn($)
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('cannot be read')
})

test('two reviewer turns in a row with an unreadable cost read pause a budgeted loop at the second, before any advance', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { noCost: true, settings: { budgetUsd: 5 }, state: { autopilot: true, current: 'T-001', reviewAgentId: ID, reviewAgentAt: 999_000, reviewWaitMs: 1_800_000 } })
  const turn = () => $.turn.complete({ answer: 'still running', durationMs: 10, isAborted: false, turnId: 'r1', reason: 'answer', agentId: ID } as never)
  await turn()
  expect(fx.state().autopilot).toBe(true)
  await turn()
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('cannot be read')
})

test('a readable cost read between two unreadable ones resets the tolerance', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { budgetUsd: 5 }, state: { autopilot: true, current: 'T-001', reviewAgentId: ID, reviewAgentAt: 999_000, reviewWaitMs: 1_800_000 } })
  const turn = () => $.turn.complete({ answer: 'still running', durationMs: 10, isAborted: false, turnId: 'r1', reason: 'answer', agentId: ID } as never)
  fx.live.usd = 1
  fx.live.noCost = true
  await turn()
  expect(fx.state().autopilot).toBe(true)
  fx.live.noCost = false
  await turn()
  expect(fx.state().autopilot).toBe(true)
  fx.live.noCost = true
  await turn()
  expect(fx.state().autopilot).toBe(true)
  await turn()
  expect(fx.state().autopilot).toBe(false)
})

test('a counter that becomes readable later is not charged for the time before', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { noCost: true })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.noCost = false
  fx.live.usd = 30
  await mainTurn($)
  fx.live.usd = 31
  await clock.advance(1000)
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toMatch(/T-001\s+\$1\.00/)
})

test('/factory-costs reset is refused while the loop runs or a turn is being charged', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect((await $.command.run({ command: 'factory-costs', args: 'reset acme/widget' } as never)).text).toContain('Cannot reset acme/widget')
  await $.command.run({ command: 'factory-stop' } as never)
  await mainTurn($)
  expect((await $.command.run({ command: 'factory-costs', args: 'reset acme/widget' } as never)).text).toContain('deleted')
  expect(fx.state().autopilot).toBe(false)
})

test('hostile item ids are refused before any file or process is touched', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  const before = { files: JSON.stringify(fx.files), ran: fx.live.ran.length }
  for (const args of ['../x', '--help', 'T-001/../..', '', '   ', 'T-001;rm -rf /', `T-${'1'.repeat(5000)}`, 'x'.repeat(5000)]) {
    for (const command of ['factory-skip', 'factory-retry']) {
      expect((await $.command.run({ command, args } as never)).text).toContain('Usage')
    }
    if (args.trim()) expect((await $.command.run({ command: 'factory-log', args } as never)).text).toContain('Usage')
  }
  expect(JSON.stringify(fx.files)).toBe(before.files)
  expect(fx.live.ran.length).toBe(before.ran)
})

test('a prompt the person types while the loop runs closes the charge at once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 2
  await $.prompt.submit({ text: 'let me do this myself', origin: { kind: 'composer' } } as never)
  fx.live.usd = 10
  await mainTurn($, { usage: usage('claude-opus-4-1', 500) })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const report = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text
  expect(report).toMatch(/T-001\s+\$1\.00/)
  expect(report).not.toContain('opus-4-1')
})


const reviewPrompt = (fx: { files: Record<string, string> }) =>
  reviewAgentPrompt(parseSettings(fx.files['.factory/settings.json']!).settings, branchFor({ id: 'T-001', title: 'First' }))

async function pendingReview($: any, on: any, settings: Record<string, unknown> = {}, extra: Opts = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: true, current: 'T-001' }, settings, branch: 'factory/t-001-first', agentText: `Async agent launched successfully.\nagentId: ${ID}`, ...extra })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Agent', description: 'review', prompt: reviewPrompt(fx), subagent_type: 'general-purpose' })
  expect(fx.state().reviewAgentId).toBe(ID)
  return Object.assign(fx, { clock })
}

async function handBack($: any, fx: { live: { usd: number } }, usd: number) {
  await $.prompt.submit({ text: 'review finished', origin: { kind: 'task-notification' } } as never)
  fx.live.usd = usd
  await mainTurn($)
  fx.live.usd = usd + 50
  await mainTurn($)
}

const itemUsd = async ($: any) => (await $.command.run({ command: 'factory-costs', args: '' } as never)).text as string
const resetText = async ($: any) => (await $.command.run({ command: 'factory-costs', args: 'reset acme/widget' } as never)).text as string

for (const command of ['factory-pause', 'factory-stop']) {
  test(`/${command} while a review is pending keeps charging the reviewer and the hand-back turn, then closes the mark`, async ($, on) => {
    const fx = await pendingReview($, on)
    fx.live.usd = 2
    await $.command.run({ command } as never)
    fx.live.usd = 3
    await mainTurn($)
    fx.live.usd = 6
    await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
    expect(fx.state().autopilot).toBe(false)
    await handBack($, fx, 8)
    expect(await itemUsd($)).toMatch(/T-001\s+\$7\.00/)
    expect(await resetText($)).toContain('deleted')
  })
}

test('a budget pause at the reviewer own turn keeps charging the hand-back turn, then closes the mark', async ($, on) => {
  const fx = await pendingReview($, on, { budgetUsd: 4 })
  fx.live.usd = 2
  await mainTurn($)
  fx.live.usd = 6
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('budget reached')
  await handBack($, fx, 9)
  expect(await itemUsd($)).toMatch(/T-001\s+\$8\.00/)
  expect(await resetText($)).toContain('deleted')
})

test('a pause for an unavailable reviewer keeps charging the hand-back turn, then closes the mark', async ($, on) => {
  const fx = await pendingReview($, on)
  fx.live.usd = 2
  await mainTurn($)
  fx.live.usd = 6
  await mainTurn($, { agentId: ID, answer: 'FACTORY-REVIEW: unavailable' })
  expect(fx.state().pausedReason).toContain('not available')
  await handBack($, fx, 9)
  expect(await itemUsd($)).toMatch(/T-001\s+\$8\.00/)
  expect(await resetText($)).toContain('deleted')
})

test('/factory-costs reset refuses another repo whose ledger still has an open mark', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { store: { 'costs/acme/other': { repo: 'acme/other', usd: 3, items: {}, runs: [], marks: { 'sess-9': { key: 'T-004', kind: 'item', title: 'Busy', usd: 3, at: 999_000 } } } } })
  const r = (await $.command.run({ command: 'factory-costs', args: 'reset acme/other' } as never)).text
  expect(r).toContain('Cannot reset acme/other')
  expect((await $.command.run({ command: 'factory-costs', args: 'all' } as never)).text).toContain('acme/other')
})

const TORN = '{"approved": true, "autop'

for (const [torn, recovers] of [[1, true], [2, true], [3, false]] as const) {
  test(`${torn} torn read(s) of state.json in a row ${recovers ? 'are retried and the real state is used' : 'fail closed for that read'}`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    let left: number = torn
    const fx = setup($, on, {
      state: { autopilot: false, current: null },
      read: path => (path.endsWith('.factory/state.json') && left-- > 0 ? TORN : undefined),
    })
    const r = (await $.command.run({ command: 'factory-start' } as never)).text
    if (recovers) {
      expect(r).toContain('Factory running')
      expect(fx.state().autopilot).toBe(true)
      expect(fx.state().approvedHash).not.toBe('')
    } else {
      expect(r).toContain('cannot be read or is not valid JSON')
      expect(fx.state().autopilot).toBe(false)
    }
  })
}

test('a read of state.json that throws once is retried, so a write never persists defaults', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let reads = 0
  const fx = setup($, on, {
    state: { autopilot: true, current: 'T-001', attempts: 2, mergedIds: ['T-000'] },
    read: path => {
      if (path.endsWith('.factory/state.json') && ++reads === 2) throw new Error('EIO')
      return undefined
    },
  })
  await $.command.run({ command: 'factory-pause' } as never)
  const saved = fx.state()
  expect(reads).toBeGreaterThan(2)
  expect(saved.approved).toBe(true)
  expect(saved.autopilot).toBe(false)
  expect(saved.current).toBe('T-001')
  expect(saved.attempts).toBe(2)
  expect(saved.mergedIds).toEqual(['T-000'])
})

test('a read of state.json that keeps throwing fails closed and the file is never rewritten', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, {
    state: { autopilot: false, current: 'T-001' },
    read: path => {
      if (path.endsWith('.factory/state.json')) throw new Error('EIO')
      return undefined
    },
  })
  const before = fx.files['.factory/state.json']
  expect(await bash($, 'git push origin main')).toContain('"deny":"code-factory: paused, .factory/state.json cannot be read')
  expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('cannot be read')
  await $.command.run({ command: 'factory-pause' } as never)
  await $.command.run({ command: 'factory-stop' } as never)
  await $.prompt.submit({ text: 'mine', origin: { kind: 'composer' } } as never)
  await clock.advance(400000)
  expect(fx.files['.factory/state.json']).toBe(before)
})

test('an absent state.json still means a fresh, unapproved factory that the commands may create', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  delete fx.files['.factory/state.json']
  expect(await bash($, 'git push origin main')).not.toContain('code-factory')
  expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('design not approved')
  await $.command.run({ command: 'factory-stop' } as never)
  expect(fx.state().approved).toBe(false)
  expect(fx.state().autopilot).toBe(false)
})

const MERGED_TODO = TODO.replace('status: todo', 'status: done')

for (const [step, matches, o] of [
  ['gh pr list', (w: string) => w.startsWith('gh pr list'), { todo: MERGED_TODO }],
  ['git branch', (w: string) => w === 'git branch --show-current', {}],
  ['the budget check', (w: string) => w === 'usage', { settings: { budgetUsd: 100 } }],
] as const) {
  test(`/factory-pause during ${step} inside advance() wins: no prompt is sent, state stays paused, the lock stays released`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let armed = false
    let fired = 0
    const fx = setup($, on, {
      ...o,
      state: { autopilot: true, current: 'T-001', attempts: 1 },
      hook: async what => {
        if (!armed || !matches(what)) return
        armed = false
        fired++
        await $.command.run({ command: 'factory-pause' } as never)
      },
    })
    fx.live.usd = 1
    await $.command.run({ command: 'factory-start' } as never)
    const sent = fx.live.submitted.length
    armed = true
    await clock.advance(1000)
    expect(fired).toBe(1)
    expect(fx.live.submitted.length).toBe(sent)
    expect(fx.state().autopilot).toBe(false)
    expect(fx.state().pausedReason).toContain('paused by you')
    expect(fx.state().attempts).toBe(1)
    expect(JSON.parse(fx.files['.factory/lock.json'] ?? '{"owner":null}').owner).toBeNull()
  })
}

test('/factory-pause after advance() wrote the nudge but before it sent it still sends nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let armed = false
  let fired = 0
  const fx = setup($, on, { todo: MERGED_TODO, state: { autopilot: true, current: 'T-001', attempts: 1 } })
  on('ui.status', async () => {
    if (armed && fx.state().attempts === 2 && fx.state().autopilot) {
      armed = false
      fired++
      await $.command.run({ command: 'factory-pause' } as never)
    }
    return { value: undefined }
  })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  const sent = fx.live.submitted.length
  armed = true
  await clock.advance(1000)
  expect(fired).toBe(1)
  expect(fx.state().events.some((e: { kind: string }) => e.kind === 'nudge')).toBe(true)
  expect(fx.live.submitted.length).toBe(sent)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('paused by you')
})

test('a pause keeps current, attempts and mergedIds that changed on disk after its snapshot', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let reads = 0
  const fx = setup($, on, {
    state: { autopilot: true, current: 'T-001', attempts: 1, mergedIds: [] },
    read: (path, files) => {
      if (!path.endsWith('.factory/state.json')) return undefined
      if (++reads === 1) {
        const stale = files['.factory/state.json']!
        files['.factory/state.json'] = JSON.stringify({ ...JSON.parse(stale), current: 'T-002', attempts: 3, mergedIds: ['T-001'] })
        return stale
      }
      return undefined
    },
  })
  await $.command.run({ command: 'factory-pause' } as never)
  const saved = fx.state()
  expect(saved.autopilot).toBe(false)
  expect(saved.current).toBe('T-002')
  expect(saved.attempts).toBe(3)
  expect(saved.mergedIds).toEqual(['T-001'])
})

test('a state.json that stays unreadable keeps the guards denying and is never overwritten', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: false } })
  fx.files['.factory/state.json'] = TORN
  expect(await bash($, 'git push origin main')).toContain('"deny":"code-factory: paused, .factory/state.json cannot be read or is not valid JSON')
  expect(await bash($, 'git commit -m x')).toContain('"deny":"code-factory: paused')
  expect(await bash($, 'gh api -X PUT repos/o/r/pulls/3/merge')).toContain('"deny"')
  expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('not valid JSON')
  await $.command.run({ command: 'factory-pause' } as never)
  await $.command.run({ command: 'factory-stop' } as never)
  await $.command.run({ command: 'factory-approve' } as never)
  await $.prompt.submit({ text: 'my own prompt', origin: { kind: 'composer' } } as never)
  await clock.advance(400000)
  expect(fx.files['.factory/state.json']).toBe(TORN)
})

const lockOwner = (fx: { files: Record<string, string> }) => JSON.parse(fx.files['.factory/lock.json'] ?? '{"owner":null}').owner as string | null
const prompts = (fx: { live: { submitted: string[] } }) => fx.live.submitted.filter(t => t.startsWith('CODE FACTORY') || t.startsWith('Code factory'))

async function blockedAdvance($: any, on: any, during: (clock: any, fx: any) => Promise<unknown>, o: Opts = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  let armed = false
  const ref: { fx: any } = { fx: null }
  ref.fx = setup($, on, {
    todo: MERGED_TODO,
    ...o,
    state: { autopilot: true, current: 'T-001', attempts: 1, ...o.state },
    hook: async what => {
      if (!armed || !what.startsWith('gh pr list')) return undefined
      armed = false
      return during(clock, ref.fx)
    },
  })
  const fx = ref.fx
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  const sent = prompts(fx).length
  armed = true
  return { fx, clock, sent }
}

test('pause then start while an advance is blocked: the new run sends its prompt within the short timer, exactly once', async ($, on) => {
  const { fx, clock, sent } = await blockedAdvance($, on, async clk => {
    await $.command.run({ command: 'factory-pause' } as never)
    await $.command.run({ command: 'factory-start' } as never)
    await clk.advance(500)
  })
  await clock.advance(1000)
  expect(prompts(fx).length).toBe(sent)
  await clock.advance(400)
  const fresh = prompts(fx).slice(sent)
  expect(fresh.length).toBe(1)
  expect(fresh[0]).toContain('T-001 retry')
  expect(fx.state().attempts).toBe(2)
  expect(fx.state().events.filter((e: { kind: string }) => e.kind === 'nudge').length).toBe(1)
  expect(fx.state().autopilot).toBe(true)
})

test('a halt from an advance that a pause and restart made stale neither pauses the new run nor frees its lock', async ($, on) => {
  const { fx, clock } = await blockedAdvance($, on, async () => {
    await $.command.run({ command: 'factory-pause' } as never)
    await $.command.run({ command: 'factory-start' } as never)
    return { exitCode: 1, stderr: 'gh: network down' }
  })
  await clock.advance(1500)
  expect(fx.state().autopilot).toBe(true)
  expect(fx.state().pausedReason ?? '').not.toContain('gh failed')
  expect(lockOwner(fx)).not.toBeNull()
  expect(prompts(fx).some(t => t.includes('T-001 retry'))).toBe(true)
})

test('/factory-start during an in-flight advance makes it stale, so its old run counters are not written', async ($, on) => {
  const { fx, clock } = await blockedAdvance($, on, async () => {
    expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('Factory running')
  }, { merged: ['T-001'], settings: { maxItemsPerRun: 2 } })
  fx.files['.factory/state.json'] = JSON.stringify({ ...fx.state(), doneThisRun: 1 })
  await clock.advance(1500)
  expect(fx.state().doneThisRun).toBe(1)
  expect(fx.state().autopilot).toBe(true)
  expect(fx.state().pausedReason).toBeNull()
  expect(prompts(fx).some(t => t.startsWith('CODE FACTORY: work item T-002'))).toBe(true)
})

test('/factory-approve during an in-flight advance makes it stale, so the re-approved settings decide the next step', async ($, on) => {
  const { fx, clock } = await blockedAdvance($, on, async (_clk, f) => {
    f.files['.factory/settings.json'] = JSON.stringify({ ...JSON.parse(f.files['.factory/settings.json']), maxAttempts: 1 })
    f.files['.factory/design.md'] = '# Design\n\n## Decisions\n- x\n'
    expect((await $.command.run({ command: 'factory-approve' } as never)).text).toContain('Approved')
  })
  await clock.advance(1500)
  expect(fx.files['.factory/blocked/T-001.md']).toContain('after 1 attempts')
  expect(prompts(fx).some(t => t.includes('T-001 retry'))).toBe(false)
})

test('/factory-stop while an advance is blocked: the old advance resumes but writes and sends nothing', async ($, on) => {
  let before = ''
  const { fx, clock, sent } = await blockedAdvance($, on, async (_clk, f) => {
    await $.command.run({ command: 'factory-stop' } as never)
    before = f.files['.factory/state.json']
  })
  await clock.advance(1500)
  expect(prompts(fx).length).toBe(sent)
  expect(fx.files['.factory/state.json']).toBe(before)
  expect(fx.state().pausedReason).toBe('stopped by you')
  expect(lockOwner(fx)).toBeNull()
})

test('another session taking the lock mid-advance: the stale advance writes and sends nothing', async ($, on) => {
  let before = ''
  const { fx, clock, sent } = await blockedAdvance($, on, async (clk, f) => {
    f.files['.factory/lock.json'] = JSON.stringify({ owner: 'other-session', heartbeat: clk.now() })
    before = f.files['.factory/state.json']
  })
  await clock.advance(1500)
  expect(prompts(fx).length).toBe(sent)
  expect(fx.state().attempts).toBe(1)
  expect(fx.files['.factory/state.json']).toBe(before)
  expect(lockOwner(fx)).toBe('other-session')
})

test('an item out of attempts whose blocked note cannot be written pauses the loop instead of retrying it forever', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, {
    todo: MERGED_TODO,
    settings: { maxAttempts: 1 },
    state: { autopilot: true, current: 'T-001', attempts: 1 },
    hook: async what => {
      if (what.startsWith('prewrite:') && what.endsWith('blocked/T-001.md')) throw new Error('read-only')
      return undefined
    },
  })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(3000)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('could not be written')
  expect(prompts(fx).filter(x => x.includes('T-001')).length).toBe(0)
})

test('a lock whose loop another session paused is released by the next heartbeat', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: MERGED_TODO, state: { autopilot: true, current: 'T-001', attempts: 0 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(lockOwner(fx)).not.toBeNull()
  fx.files['.factory/state.json'] = JSON.stringify({ ...fx.state(), autopilot: false, pausedReason: 'paused elsewhere' })
  await clock.advance(31000)
  expect(lockOwner(fx)).toBeNull()
})

const heartbeatOf = (fx: { files: Record<string, string> }) => JSON.parse(fx.files['.factory/lock.json'] ?? '{"heartbeat":0}').heartbeat as number

test('a running loop keeps its lock and renews the heartbeat', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const first = heartbeatOf(fx)
  await clock.advance(100000)
  expect(fx.state().autopilot).toBe(true)
  expect(lockOwner(fx)).not.toBeNull()
  expect(heartbeatOf(fx)).toBeGreaterThan(first)
})

test('a prompt the person types pauses the running loop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(true)
  await $.prompt.submit({ text: 'wait, do this instead', origin: { kind: 'composer' } } as never)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toBeTruthy()
})

test('an interrupted factory turn pauses the loop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  await mainTurn($, { reason: 'aborted', isAborted: true })
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toBe('you interrupted it')
})

test('a factory turn that ends in an error pauses the loop with that reason', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  await mainTurn($, { reason: 'error' })
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toBe('turn ended with error')
})

test('/factory-start with every item done still runs the pending release', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, {
    todo: VERSIONED.replace('status: todo', 'status: done'),
    settings: { stopAfterVersion: '0.2', tagRelease: true },
    state: { approvedDone: ['T-001', 'T-002'], roadmapAsked: true },
    hook: what => (what.startsWith('gh release view') ? { exitCode: 1, stderr: 'release not found' } : undefined),
  })
  fx.live.usd = 1
  const reply = (await $.command.run({ command: 'factory-start' } as never)).text
  await clock.advance(2000)
  expect(reply).not.toContain('Nothing to do')
  expect(prompts(fx).some(x => x.includes('release v0.2'))).toBe(true)
})

test('/factory-start with every item done and the release cut asks for the next phase once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, state: { approvedDone: ['T-001', 'T-002'] } })
  fx.live.usd = 1
  const reply = (await $.command.run({ command: 'factory-start' } as never)).text
  await clock.advance(2000)
  expect(reply).not.toContain('Nothing to do')
  expect(fx.live.submitted.some(x => x.includes('next-phase interview'))).toBe(true)
  const again = (await $.command.run({ command: 'factory-start' } as never)).text
  expect(again).toContain('Nothing to do')
})

test('a prompt typed in a session that does not hold the lock leaves the other session\'s loop running', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { lockedBy: 'other-session', state: { autopilot: true, current: 'T-001' } })
  await $.prompt.submit({ text: 'something unrelated', origin: { kind: 'composer' } } as never)
  expect(fx.state().autopilot).toBe(true)
  expect(lockOwner(fx)).toBe('other-session')
})

test('after a prompt typed beside another session\'s loop, this session does not take the loop over when that lock goes stale', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { lockedBy: 'other-session', state: { autopilot: true, current: 'T-001' } })
  fx.live.usd = 1
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work/widget', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: 'something unrelated', origin: { kind: 'composer' } } as never)
  fx.files['.factory/lock.json'] = JSON.stringify({ owner: 'other-session', heartbeat: 0 })
  await clock.advance(310000)
  expect(prompts(fx)).toEqual([])
  expect(lockOwner(fx)).toBe('other-session')
  expect(fx.state().autopilot).toBe(true)
})

test('the person is told when a typed prompt leaves this session out of another session\'s loop', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const toasts: string[] = []
  setup($, on, { lockedBy: 'other-session', state: { autopilot: true, current: 'T-001' } })
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.prompt.submit({ text: 'something unrelated', origin: { kind: 'composer' } } as never)
  expect(toasts.some(t => t.includes('/factory-start takes it over'))).toBe(true)
})

test('a refused /factory-start keeps this session out of the loop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { lockedBy: 'other-session', state: { autopilot: true, current: 'T-001' } })
  fx.live.usd = 1
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work/widget', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: 'something unrelated', origin: { kind: 'composer' } } as never)
  expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('another session is running')
  fx.files['.factory/lock.json'] = JSON.stringify({ owner: 'other-session', heartbeat: 0 })
  await clock.advance(310000)
  expect(prompts(fx)).toEqual([])
})

test('a .factory/.gitignore that cannot be written does not break /factory-start', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, {
    hook: what => {
      if (what.startsWith('prewrite:') && what.endsWith('.gitignore')) throw new Error('read-only')
      return undefined
    },
  })
  fx.live.usd = 1
  const reply = (await $.command.run({ command: 'factory-start' } as never)).text
  await clock.advance(1000)
  expect(reply).not.toContain('Cannot')
  expect(fx.state().autopilot).toBe(true)
})

test('/factory-start after such a prompt takes the loop over again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { lockedBy: 'other-session', state: { autopilot: true, current: 'T-001' } })
  fx.live.usd = 1
  await $.prompt.submit({ text: 'something unrelated', origin: { kind: 'composer' } } as never)
  fx.files['.factory/lock.json'] = JSON.stringify({ owner: 'other-session', heartbeat: 0 })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(2000)
  expect(prompts(fx).length).toBeGreaterThan(0)
})

for (const command of ['factory-start', 'factory-approve']) {
  test(`/${command} makes sure .factory/.gitignore hides the runtime files`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const fx = setup($, on)
    expect(fx.files['.factory/.gitignore']).toBeUndefined()
    await $.command.run({ command } as never)
    expect(fx.files['.factory/.gitignore']).toContain('state.json')
    expect(fx.files['.factory/.gitignore']).toContain('lock.json')
  })
}

function midStep($: any, command: string, when: (f: any) => boolean, done: (f: any) => boolean) {
  const t = { armed: false, fired: 0, fx: null as any }
  const hook = async (what: string) => {
    if (what !== 'usage' || !t.armed || !when(t.fx)) return undefined
    t.armed = false
    t.fired++
    void $.command.run({ command } as never)
    for (let i = 0; i < 2000 && !done(t.fx); i++) await Promise.resolve()
    return undefined
  }
  return { t, hook }
}

test('a pause between the nudge write and its hand-out notes no attempt in the ledger and sends nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { t, hook } = midStep($, 'factory-pause', f => f.state().attempts === 2 && f.state().autopilot, f => !f.state().autopilot)
  const fx = (t.fx = setup($, on, { todo: MERGED_TODO, state: { autopilot: true, current: 'T-001', attempts: 1 }, hook }))
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  const sent = prompts(fx).length
  t.armed = true
  await clock.advance(1000)
  expect(t.fired).toBe(1)
  expect(fx.state().autopilot).toBe(false)
  expect(prompts(fx).length).toBe(sent)
  expect((await $.command.run({ command: 'factory-costs', args: '' } as never)).text).not.toMatch(/T-001/)
})

function clears(on: any) {
  const ran: string[] = []
  on('command.run', (_: unknown, e: { command: string }) => {
    ran.push(e.command)
    return { text: '' }
  })
  return ran
}

test('a pause after advance() picked the next item skips the context reset', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { t, hook } = midStep($, 'factory-pause', f => f.state().current === 'T-002' && f.state().autopilot, f => !f.state().autopilot)
  const fx = (t.fx = setup($, on, { todo: MERGED_TODO, merged: ['T-001'], settings: { contextReset: 'clear' }, state: { autopilot: true, current: 'T-001' }, hook }))
  const ran = clears(on)
  await $.command.run({ command: 'factory-start' } as never)
  t.armed = true
  await clock.advance(1000)
  expect(t.fired).toBe(1)
  expect(fx.state().autopilot).toBe(false)
  expect(ran).not.toContain('clear')
  expect(prompts(fx).some(x => x.startsWith('CODE FACTORY: work item T-002'))).toBe(false)
})

const VERSIONED = `## T-001 [chore] First
- status: done
- version: 0.1
- how: Use the standard library only, because zero dependencies.
- accept: The first thing works for documented inputs.
- tests: none needed for a chore.

## T-002 [chore] Second
- status: todo
- version: 0.2
- how: Use the standard library only, because zero dependencies.
- accept: The second thing works for documented inputs.
- tests: none needed for a chore.
`

test('a pause after advance() wrote the release step skips the context reset and the release prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const released = (f: any) => f.state().events.some((e: { kind: string }) => e.kind === 'release')
  const { t, hook: mid } = midStep($, 'factory-pause', f => released(f) && f.state().autopilot, f => !f.state().autopilot)
  const fx = (t.fx = setup($, on, {
    todo: VERSIONED,
    merged: ['T-001'],
    settings: { contextReset: 'clear', stopAfterVersion: '0.1', tagRelease: true },
    state: { autopilot: true, current: 'T-001' },
    hook: what => (what.startsWith('gh release view') ? { exitCode: 1, stderr: 'release not found' } : mid(what)),
  }))
  const ran = clears(on)
  await $.command.run({ command: 'factory-start' } as never)
  t.armed = true
  await clock.advance(1000)
  expect(t.fired).toBe(1)
  expect(released(fx)).toBe(true)
  expect(fx.state().autopilot).toBe(false)
  expect(ran).not.toContain('clear')
  expect(prompts(fx).some(x => x.includes('release v0.1'))).toBe(false)
})

test('/factory-stop between the finished write and the next-phase launch stops the interview from starting', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { t, hook } = midStep($, 'factory-stop', f => f.state().pausedReason === 'nothing left to do', f => f.state().pausedReason === 'stopped by you')
  const fx = (t.fx = setup($, on, { todo: DONE_TODO, merged: ['T-002'], state: { autopilot: true, current: 'T-002', approvedDone: ['T-001'] }, hook }))
  await $.command.run({ command: 'factory-start' } as never)
  t.armed = true
  await clock.advance(2000)
  expect(t.fired).toBe(1)
  expect(fx.state().pausedReason).toBe('stopped by you')
  expect(fx.live.submitted.some(x => x.includes('next-phase interview'))).toBe(false)
})

test('/factory-stop during the /clear before the next-phase interview stops the interview from starting', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, merged: ['T-002'], settings: { contextReset: 'clear' }, state: { autopilot: true, current: 'T-002', approvedDone: ['T-001'] } })
  on('command.run', async (_: unknown, e: { command: string }) => {
    if (e.command === 'clear') await $.command.run({ command: 'factory-stop' } as never)
    return { text: '' }
  })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(2000)
  expect(fx.state().pausedReason).toBe('stopped by you')
  expect(fx.live.submitted.some(x => x.includes('next-phase interview'))).toBe(false)
})

for (const [content, label] of [['[]', 'an array'], ['null', 'null'], ['0', 'a number'], ['"x"', 'a string']] as const) {
  test(`a state.json holding ${label} is unreadable: guards deny, start refuses, the file is untouched`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const fx = setup($, on, { state: { autopilot: false } })
    fx.files['.factory/state.json'] = content
    expect(await bash($, 'git push origin main')).toContain('"deny":"code-factory: paused, .factory/state.json cannot be read')
    expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('cannot be read')
    await $.command.run({ command: 'factory-stop' } as never)
    expect(fx.files['.factory/state.json']).toBe(content)
  })
}

test('a ledger that cannot be written pauses a budgeted loop instead of running it unmetered', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { storeSetFails: true, settings: { budgetUsd: 5 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('cannot be read')
  expect(prompts(fx).some(t => t.startsWith('CODE FACTORY: work item'))).toBe(false)
})

test('a ledger that cannot be written does not stop a loop without a budget', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { storeSetFails: true })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(true)
  expect(prompts(fx).some(t => t.startsWith('CODE FACTORY: work item T-001'))).toBe(true)
})

test('/factory-roadmap is refused while a factory turn (for example a release) is in flight', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, state: { approvedDone: ['T-001', 'T-002'] } })
  await $.command.run({ command: 'factory-roadmap' } as never)
  await clock.advance(1000)
  const r = (await $.command.run({ command: 'factory-roadmap' } as never)).text
  expect(r).toContain('Cannot plan the next phase now')
  await clock.advance(1000)
  expect(fx.live.submitted.filter(t => t.includes('next-phase interview')).length).toBe(1)
})

test('two /factory-roadmap within the launch delay start one interview', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, state: { approvedDone: ['T-001', 'T-002'] } })
  expect((await $.command.run({ command: 'factory-roadmap' } as never)).text).toContain('next-phase interview starting')
  expect((await $.command.run({ command: 'factory-roadmap' } as never)).text).toContain('already starting')
  await clock.advance(1000)
  expect(fx.live.submitted.filter(t => t.includes('next-phase interview')).length).toBe(1)
  await mainTurn($)
  expect((await $.command.run({ command: 'factory-roadmap' } as never)).text).toContain('next-phase interview starting')
})

const spin = async (until: () => boolean, max = 5000) => {
  for (let i = 0; i < max && !until(); i++) await Promise.resolve()
}

test('a state.json that turns unreadable mid-loop: one toast, the lock is released, status says paused, and a fixed file restarts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const toasts: string[] = []
  const fx = setup($, on)
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const sent = prompts(fx).length
  expect(sent).toBe(1)
  const good = fx.files['.factory/state.json']!
  fx.files['.factory/state.json'] = TORN
  await mainTurn($)
  await clock.advance(1000)
  const reasonToasts = () => toasts.filter(t => t.includes('cannot be read or is not valid JSON')).length
  expect(reasonToasts()).toBe(1)
  expect(lockOwner(fx)).toBeNull()
  expect(prompts(fx).length).toBe(sent)
  const status = (await $.command.run({ command: 'factory-status' } as never)).text
  expect(status).toContain('paused (')
  expect(status).toContain('cannot be read')
  expect(status).not.toContain('Factory: running')
  const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  expect(await ui.find({ type: 'Text', text: /factory ⏸ .*cannot be read/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /factory ▶/ })).toBeUndefined()
  await ui.unmount()
  await clock.advance(300000)
  expect(reasonToasts()).toBe(1)
  expect(lockOwner(fx)).toBeNull()
  expect(fx.files['.factory/state.json']).toBe(TORN)
  fx.files['.factory/state.json'] = JSON.stringify({ ...JSON.parse(good), autopilot: false })
  expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('Factory running')
  await clock.advance(1000)
  expect(prompts(fx).length).toBeGreaterThan(sent)
  fx.files['.factory/state.json'] = TORN
  await mainTurn($)
  await clock.advance(1000)
  expect(reasonToasts()).toBe(2)
})

for (const [label, trigger] of [
  ['between load() and acquireLock', (w: string) => w.startsWith('read:') && w.endsWith('.factory/lock.json')],
  ['between the lock write and its confirmation', (w: string) => w.startsWith('write:') && w.endsWith('.factory/lock.json')],
] as const) {
  test(`/factory-stop landing ${label} leaves the lock free with no heartbeat and the advance does nothing`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const t = { armed: false, fired: 0, ranAt: 0 }
    const fx = setup($, on, {
      todo: MERGED_TODO,
      state: { autopilot: true, current: 'T-001', attempts: 1 },
      hook: async what => {
        if (!t.armed || !trigger(what)) return undefined
        t.armed = false
        t.fired++
        await $.command.run({ command: 'factory-stop' } as never)
        t.ranAt = fx.live.ran.length
        return undefined
      },
    })
    await $.command.run({ command: 'factory-start' } as never)
    const sent = prompts(fx).length
    t.armed = true
    await clock.advance(1000)
    expect(t.fired).toBe(1)
    expect(fx.state().pausedReason).toBe('stopped by you')
    expect(lockOwner(fx)).toBeNull()
    expect(fx.live.ran.slice(t.ranAt).some(c => c.startsWith('gh pr list') || c === 'git branch --show-current')).toBe(false)
    expect(prompts(fx).length).toBe(sent)
    await clock.advance(70000)
    expect(lockOwner(fx)).toBeNull()
  })
}

test('an advance that is aborted every time re-arms at most MAX_REARMS times, then stops', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const t = { armed: false }
  const fx = setup($, on, {
    todo: MERGED_TODO,
    state: { autopilot: true, current: 'T-001', attempts: 1 },
    hook: async what => {
      if (!t.armed || !what.startsWith('gh pr list')) return undefined
      expect((await $.command.run({ command: 'factory-approve' } as never)).text).toContain('Approved')
      return undefined
    },
  })
  fx.files['.factory/design.md'] = '# Design\n\n## Decisions\n- x\n'
  await $.command.run({ command: 'factory-start' } as never)
  t.armed = true
  await clock.advance(60000)
  expect(fx.live.ran.filter(c => c.startsWith('gh pr list')).length).toBe(4)
  expect(prompts(fx).some(x => x.includes('T-001 retry'))).toBe(false)
})

test('a person pause bumps the epoch at once, so an advance checking in before the pause is written still stops', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => {
    release = r
  })
  const t = { armed: false, gating: false, held: false, fired: 0 }
  const ref: { fx: any } = { fx: null }
  const fx = (ref.fx = setup($, on, {
    todo: MERGED_TODO,
    state: { autopilot: true, current: 'T-001', attempts: 1 },
    hook: async what => {
      if (t.gating && what.startsWith('prewrite:') && what.endsWith('.factory/state.json')) {
        t.gating = false
        t.held = true
        await gate
        return undefined
      }
      if (!t.armed || what !== 'usage' || ref.fx.state().attempts !== 2) return undefined
      t.armed = false
      t.fired++
      t.gating = true
      void $.command.run({ command: 'factory-skip', args: 'T-002 parked for the test' } as never)
      await spin(() => t.held)
      void $.command.run({ command: 'factory-pause' } as never)
      await spin(() => false, 3000)
      return undefined
    },
  }))
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  const sent = prompts(fx).length
  t.armed = true
  await clock.advance(1000)
  expect(t.fired).toBe(1)
  expect(t.held).toBe(true)
  expect(prompts(fx).length).toBe(sent)
  release()
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('paused by you')
  expect(prompts(fx).length).toBe(sent)
})

test('/factory-approve on an unreadable state.json refuses and never says Approved', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { state: { autopilot: false } })
  fx.files['.factory/design.md'] = '# Design\n\n## Decisions\n- x\n'
  fx.files['.factory/state.json'] = TORN
  const r = (await $.command.run({ command: 'factory-approve' } as never)).text
  expect(r).toContain('Not approved')
  expect(r).toContain('cannot be read')
  expect(r).not.toContain('Approved.')
  expect(fx.files['.factory/state.json']).toBe(TORN)
})

test('the session ending charges the open turn to the ledger', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  on('session.end', () => ({ sessionId: 'sess-1' }))
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 4
  await $.session.end({ reason: 'other' } as never)
  expect((await $.command.run({ command: 'factory-costs', args: '' } as never)).text).toMatch(/T-001\s+\$3\.00/)
})

test('a counter that is unreadable while the next turn is handed out still charges that turn, and the budget catches it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let thrown = 0
  const ref: { fx: any } = { fx: null }
  const fx = (ref.fx = setup($, on, {
    settings: { budgetUsd: 5 },
    hook: what => {
      if (what === 'usage' && ref.fx?.state().attempts === 1 && prompts(ref.fx).length < 2) {
        thrown++
        throw new Error('usage unavailable')
      }
      return undefined
    },
  }))
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 2
  await mainTurn($)
  await clock.advance(1000)
  expect(prompts(fx).length).toBe(2)
  expect(prompts(fx)[1]).toContain('T-001 retry')
  fx.live.usd = 6
  await mainTurn($)
  await clock.advance(1000)
  expect(thrown).toBeGreaterThan(0)
  expect((await $.command.run({ command: 'factory-costs', args: '' } as never)).text).toMatch(/T-001\s+\$5\.00/)
  expect(fx.state().autopilot).toBe(false)
  expect(fx.state().pausedReason).toContain('budget reached')
})

test('a stop and restart landing between load() and acquireLock make that advance stale, so its old snapshot decides nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const t = { armed: false, fired: 0 }
  const fx = setup($, on, {
    todo: MERGED_TODO,
    merged: ['T-001'],
    settings: { maxItemsPerRun: 2 },
    state: { autopilot: true, current: 'T-001' },
    hook: async what => {
      if (!t.armed || !(what.startsWith('read:') && what.endsWith('.factory/lock.json'))) return undefined
      t.armed = false
      t.fired++
      await $.command.run({ command: 'factory-stop' } as never)
      expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('Factory running')
      return undefined
    },
  })
  await $.command.run({ command: 'factory-start' } as never)
  fx.files['.factory/state.json'] = JSON.stringify({ ...fx.state(), doneThisRun: 1 })
  t.armed = true
  await clock.advance(1500)
  expect(t.fired).toBe(1)
  expect(fx.state().autopilot).toBe(true)
  expect(fx.state().pausedReason).toBeNull()
  expect(fx.state().doneThisRun).toBe(1)
  expect(prompts(fx).some(x => x.startsWith('CODE FACTORY: work item T-002'))).toBe(true)
})

const ledgerOf = async ($: any) => (await $.command.run({ command: 'factory-costs', args: '' } as never)).text as string
const outcomeRow = (report: string, outcome: string) => new RegExp(`T-001\\s+\\S+\\s+\\S+\\s+\\d+\\s+\\S+\\s+${outcome}`).test(report)

const SIDE_EFFECT_CASES = [
  ['attempts-exhausted', 'git branch', { todo: TODO, branch: 'main' }, (w: string) => w === 'git branch --show-current'],
  ['attempts-exhausted', 'gh pr list', { todo: MERGED_TODO, branch: 'main' }, (w: string) => w.startsWith('gh pr list')],
  ['attempts-exhausted', 'the CI billing look-up', { todo: TODO, branch: 'factory/t-001-first' }, (w: string) => w === 'git rev-parse HEAD'],
  ['merged', 'git branch', { todo: MERGED_TODO, branch: 'main', merged: ['T-001'] }, (w: string) => w === 'git branch --show-current'],
  ['merged', 'gh pr list', { todo: MERGED_TODO, branch: 'main', merged: ['T-001'] }, (w: string) => w.startsWith('gh pr list')],
] as const

for (const [branchKind, step, o, trigger] of SIDE_EFFECT_CASES) {
  for (const command of ['factory-pause', 'factory-stop']) {
    test(`/${command} during ${step} in the ${branchKind} branch leaves no blocked note and no ledger outcome; a restart decides the item once`, async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      const t = { armed: false, fired: 0 }
      const fx = setup($, on, {
        ...(o as unknown as Opts),
        state: { autopilot: true, current: 'T-001', attempts: 4 },
        hook: async what => {
          if (!t.armed || !trigger(what)) return undefined
          t.armed = false
          t.fired++
          await $.command.run({ command } as never)
          return undefined
        },
      })
      fx.live.usd = 1
      await $.command.run({ command: 'factory-start' } as never)
      t.armed = true
      await clock.advance(1500)
      expect(t.fired).toBe(1)
      expect(fx.state().autopilot).toBe(false)
      expect(fx.state().current).toBe('T-001')
      expect(fx.state().attempts).toBe(4)
      expect(fx.files['.factory/blocked/T-001.md']).toBeUndefined()
      expect(fx.state().mergedIds).toEqual([])
      const report = await ledgerOf($)
      expect(outcomeRow(report, 'blocked')).toBe(false)
      expect(outcomeRow(report, 'merged')).toBe(false)
      expect(report).not.toMatch(/last run: \S+, [1-9]\d* item\(s\) merged/)
      expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('Factory running')
      await clock.advance(1500)
      const kinds = fx.state().events.map((e: { kind: string }) => e.kind)
      if (branchKind === 'merged') {
        expect(kinds.filter((k: string) => k === 'done').length).toBe(1)
        expect(fx.state().mergedIds).toEqual(['T-001'])
        expect(await ledgerOf($)).toMatch(/last run: \S+, 1 item\(s\) merged/)
      } else {
        expect(kinds.filter((k: string) => k === 'blocked').length).toBe(1)
        expect(fx.files['.factory/blocked/T-001.md']).toContain('after 4 attempts')
        expect(outcomeRow(await ledgerOf($), 'blocked')).toBe(true)
      }
    })
  }
}

test('state.json turning unreadable during an advance stops it: no write, nothing sent, the lock is released', async ($, on) => {
  let before = ''
  const { fx, clock, sent } = await blockedAdvance($, on, async (_clk, f) => {
    f.files['.factory/state.json'] = TORN
    before = TORN
  })
  await clock.advance(1500)
  expect(prompts(fx).length).toBe(sent)
  expect(fx.files['.factory/state.json']).toBe(before)
  expect(lockOwner(fx)).toBeNull()
})

test('an advance made stale while the loop stays live never frees the live run lock', async ($, on) => {
  const { fx, clock } = await blockedAdvance($, on, async (_clk, f) => {
    f.files['.factory/design.md'] = '# Design\n\n## Decisions\n- x\n'
    expect((await $.command.run({ command: 'factory-approve' } as never)).text).toContain('Approved')
  })
  await clock.advance(400)
  expect(fx.live.ran.filter((c: string) => c.startsWith('gh pr list')).length).toBe(1)
  expect(fx.state().autopilot).toBe(true)
  expect(lockOwner(fx)).not.toBeNull()
})

test('a stop and restart landing while load() reads make that advance stale, so its old snapshot decides nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const t = { armed: false, fired: 0 }
  const fx = setup($, on, {
    todo: MERGED_TODO,
    merged: ['T-001'],
    settings: { maxItemsPerRun: 2 },
    state: { autopilot: true, current: 'T-001' },
    hook: async what => {
      if (!t.armed || !(what.startsWith('exists:') && what.endsWith('.factory/blocked'))) return undefined
      t.armed = false
      t.fired++
      await $.command.run({ command: 'factory-stop' } as never)
      expect((await $.command.run({ command: 'factory-start' } as never)).text).toContain('Factory running')
      return undefined
    },
  })
  await $.command.run({ command: 'factory-start' } as never)
  fx.files['.factory/state.json'] = JSON.stringify({ ...fx.state(), doneThisRun: 1 })
  t.armed = true
  await clock.advance(1500)
  expect(t.fired).toBe(1)
  expect(fx.state().autopilot).toBe(true)
  expect(fx.state().pausedReason).toBeNull()
  expect(fx.state().doneThisRun).toBe(1)
  expect(prompts(fx).some(x => x.startsWith('CODE FACTORY: work item T-002'))).toBe(true)
})

test('another session taking the lock after the finishing write keeps the next-phase interview from starting', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const t = { fired: 0 }
  const ref: { fx: any } = { fx: null }
  const fx = (ref.fx = setup($, on, {
    todo: DONE_TODO,
    merged: ['T-002'],
    state: { autopilot: true, current: 'T-002', approvedDone: ['T-001'] },
    hook: async what => {
      if (t.fired || what !== 'usage' || ref.fx?.state().pausedReason !== 'nothing left to do' || lockOwner(ref.fx) !== null) return undefined
      t.fired++
      ref.fx.files['.factory/lock.json'] = JSON.stringify({ owner: 'other-session', heartbeat: clock.now() })
      return undefined
    },
  }))
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(2000)
  expect(t.fired).toBe(1)
  expect(fx.state().roadmapAsked).toBe(true)
  expect(fx.live.submitted.some(x => x.includes('next-phase interview'))).toBe(false)
})

const SEEDED = { 'costs/acme/widget': { repo: 'acme/widget', usd: 1, items: {}, runs: [{ startedAt: 0, lastAt: 0, usd: 1, items: 0 }], marks: {} } }

test('/factory-costs reset of this repo is refused while the loop is live, even with no open mark', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { storeSetFails: true, store: SEEDED })
  await $.command.run({ command: 'factory-start' } as never)
  expect(await resetText($)).toContain('Cannot reset acme/widget')
})

test('/factory-costs reset of this repo is refused while a factory turn or a reviewer is in flight, even with no open mark', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { storeSetFails: true, store: SEEDED, state: { autopilot: true, current: 'T-001' }, branch: 'factory/t-001-first', agentText: `Async agent launched successfully.\nagentId: ${ID}` })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Agent', description: 'review', prompt: reviewPrompt(fx), subagent_type: 'general-purpose' })
  await $.command.run({ command: 'factory-pause' } as never)
  expect(fx.state().autopilot).toBe(false)
  expect(await resetText($)).toContain('Cannot reset acme/widget')
  await mainTurn($)
  expect(await resetText($)).toContain('Cannot reset acme/widget')
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  await $.prompt.submit({ text: 'review finished', origin: { kind: 'task-notification' } } as never)
  await mainTurn($)
  expect(await resetText($)).toContain('deleted')
})

test('/factory-costs reset of this repo is refused while another session holds the lock, even with no open mark', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { storeSetFails: true, store: SEEDED, lockedBy: 'other-session' })
  expect(await resetText($)).toContain('Cannot reset acme/widget')
})

const EVIL_BITS = ['\x1b]8;;http://evil\x07click\x1b]8;;\x07', '\x1b[2K', '\x1b[2J', '\x00', '\x9b31m', '‮', '⁦', '​', '\x7f']
const EVIL = `ok${EVIL_BITS.join('')}end`
const DIRTY = /[\x00-\x09\x0b-\x1f\x7f-\x9f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/

test('model-written commit messages, PR urls, blocked notes and titles reach /factory-log, /factory-status, the status line and the band without control characters', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const statuses: string[] = []
  const fx = setup($, on, {
    todo: TODO.replace('[chore] First', `[chore] First${EVIL}`),
    state: { autopilot: true, current: 'T-001', pausedReason: null },
    branch: 'factory/t-001-first',
    bashText: `https://github.com/acme/widget/pull/31\x1b[2K\x1b]8;;http://evil\x07x`,
    files: { '.factory/blocked/T-002.md': `# T-002\n\x1b[2Jstuck${EVIL}\n` },
  })
  on('ui.status', (_: unknown, e: { text?: string }) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  await $.tool.call({ tool: 'Bash', command: `git commit -m "fix${EVIL}"` })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title t --body b' })
  for (const e of fx.state().events as { detail: string; url?: string }[]) {
    expect(DIRTY.test(e.detail)).toBe(false)
    expect(DIRTY.test(e.url ?? '')).toBe(false)
  }
  const log = (await $.command.run({ command: 'factory-log', args: '' } as never)).text as string
  expect(log).toContain('fixok')
  expect(log).toContain('#31 https://github.com/acme/widget/pull/31')
  expect(DIRTY.test(log)).toBe(false)
  const status = (await $.command.run({ command: 'factory-status' } as never)).text as string
  expect(status).toContain('stuck')
  expect(status).toContain('First')
  expect(DIRTY.test(status)).toBe(false)
  const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text?: string }) => t.text ?? '')
  expect(texts.some((t: string) => t.includes('First'))).toBe(true)
  for (const t of texts) expect(DIRTY.test(t)).toBe(false)
  await ui.unmount()
  for (const t of statuses) expect(DIRTY.test(t)).toBe(false)
})

test('/factory-approve output lists todo titles without control characters', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { todo: TODO.replace('[chore] Second', `[chore] Second${EVIL}`), state: { approved: false, approvedHash: '' }, files: { '.factory/design.md': '# Design\n\n## Decisions\n- x\n' } })
  const text = (await $.command.run({ command: 'factory-approve' } as never)).text as string
  expect(text).toContain('Second')
  expect(DIRTY.test(text)).toBe(false)
})

test('a paused reason with control characters already on disk reaches the status line, /factory-status and the band clean', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const statuses: string[] = []
  setup($, on, { state: { autopilot: false, pausedReason: `why${EVIL}` } })
  on('ui.status', (_: unknown, e: { text?: string }) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work/widget', surface: 'terminal', isInteractive: false })
  const status = (await $.command.run({ command: 'factory-status' } as never)).text as string
  expect(status).toContain('paused (whyok')
  expect(DIRTY.test(status)).toBe(false)
  expect(statuses.some(t => t.includes('whyok'))).toBe(true)
  for (const t of statuses) expect(DIRTY.test(t)).toBe(false)
  const ui = await $.ui.mount({ plugin: 'code-factory', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text?: string }) => t.text ?? '')
  expect(texts.some((t: string) => t.includes('whyok'))).toBe(true)
  for (const t of texts) expect(DIRTY.test(t)).toBe(false)
  await ui.unmount()
})

test('a run started by another working tree of the same repo does not reset this tree budget, and /factory-start here leaves the other run alone', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const ledger = {
    repo: 'acme/widget',
    usd: 7.5,
    items: {},
    runs: [
      { startedAt: 0, lastAt: 10, usd: 4.5, items: 0, tree: '/work/widget' },
      { startedAt: 20, lastAt: 30, usd: 3, items: 2, tree: '/work/other' },
    ],
    marks: {},
  }
  const mem: Record<string, unknown> = { 'costs/acme/widget': ledger }
  setup($, on, { settings: { budgetUsd: 5 }, state: { autopilot: false, pausedReason: 'stopped by you' }, storeRef: mem })
  const status = (await $.command.run({ command: 'factory-status' } as never)).text as string
  expect(status).toContain('This run: $4.50 of the $5.00 budget')
  const costs = (await $.command.run({ command: 'factory-costs', args: '' } as never)).text as string
  expect(costs).toContain('acme/widget (this repo): $7.50')
  await $.command.run({ command: 'factory-start' } as never)
  const after = mem['costs/acme/widget'] as { runs: { tree: string; usd: number; items: number }[] }
  expect(after.runs.filter(r => r.tree === '/work/other')).toEqual([{ startedAt: 20, lastAt: 30, usd: 3, items: 2, tree: '/work/other' }])
  expect(after.runs[after.runs.length - 1]).toEqual({ startedAt: 1_000_000, lastAt: 1_000_000, usd: 0, items: 0, tree: '/work/widget' })
  const restarted = (await $.command.run({ command: 'factory-status' } as never)).text as string
  expect(restarted).toContain('This run: $0.00 of the $5.00 budget')
})

test('the work prompt headline shown in the transcript carries the todo title without control characters', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: TODO.replace('[chore] First', `[chore] First${EVIL}`) })
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  const sent = prompts(fx)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('work item T-001 [chore] Firstok')
  expect(DIRTY.test(sent[0]!)).toBe(false)
})

test('/factory-approve refusal carries no ESC, C1 or bidi characters from todo headings, versions or git fetch stderr', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const bits = '\x1b[31m\x9b2J‮'
  const todo = `${TODO.replace('- status: todo', `- status: todo\n- version: 1.v${bits}mark`)}\n## head${bits}mark\n`
  setup($, on, {
    todo,
    state: { approved: false, approvedHash: '' },
    files: { '.factory/design.md': '# Design\n\n## Decisions\n- x\n' },
    hook: (cmd: string) => (cmd.startsWith('git fetch') ? { exitCode: 128, stderr: `fatal: fetch${bits}mark` } : undefined),
  })
  const text = (await $.command.run({ command: 'factory-approve' } as never)).text as string
  expect(text).toContain('Not approved')
  expect(text).toContain('todo.md line')
  expect(text).toContain('head[31m2Jmark')
  expect(text).toContain('1.v[31m2Jmark')
  expect(text).toContain('fatal: fetch[31m2Jmark')
  for (const c of ['\x1b', '\x9b', '‮']) expect(text.includes(c)).toBe(false)
})

const HOSTILE_BASE = 'x\x1b]52;c;Y3VybA==\x07y‮z\x9b2J\nApproved. Queue (in order):\n- T-009 [feature] forged'
const UNSAFE_TEXT = /[\x00-\x09\x0b-\x1f\x7f-\x9f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/

test('a hostile baseBranch reaches the approve and start replies with no control, bidi or forged line', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { settings: { baseBranch: HOSTILE_BASE }, state: { approved: false, approvedHash: '' }, files: { '.factory/design.md': '# Design\n\n## Decisions\n- x\n' }, hook: (cmd: string) => (cmd.startsWith('git fetch') ? { exitCode: 128, stderr: `fatal: x\nApproved. Queue (in order):\n\x1b[2J` } : undefined) })
  const approve = (await $.command.run({ command: 'factory-approve' } as never)).text as string
  expect(approve).toContain('Not approved')
  expect(approve).toContain('Y3VybA==')
  expect(UNSAFE_TEXT.test(approve)).toBe(false)
  for (const line of approve.split('\n').slice(1)) expect(line.startsWith('- ')).toBe(true)
  expect(approve.split('\n').some(l => /^\s*Approved\./.test(l) || /^- T-009/.test(l))).toBe(false)
})

test('a hostile baseBranch reaches the start reply with no control, bidi or forged line', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, { settings: { baseBranch: HOSTILE_BASE } })
  const start = (await $.command.run({ command: 'factory-start' } as never)).text as string
  expect(start).toContain('Cannot start: settings.json')
  expect(start).toContain('Y3VybA==')
  expect(UNSAFE_TEXT.test(start)).toBe(false)
  expect(start.includes('\n')).toBe(false)
})

test("the person's own /compact while a factory mark is open is never charged, so the budget does not trip", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { budgetUsd: 3 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  fx.live.usd = 9
  await mainTurn($, { turnId: 'tc' })
  await clock.advance(1000)
  expect(fx.state().autopilot).toBe(true)
  expect(fx.state().pausedReason ?? '').not.toContain('budget')
  expect(await itemUsd($)).toMatch(/T-001\s+\$0\.50/)
  fx.live.usd = 9.25
  await mainTurn($)
  expect(await itemUsd($)).toMatch(/T-001\s+\$0\.75/)
})

test("with a review pending, the person's slash turn is cut out but the reviewer's spend before and after it is charged", async ($, on) => {
  const fx = await pendingReview($, on, { budgetUsd: 3 })
  fx.live.usd = 1.5
  await mainTurn($)
  fx.live.usd = 2
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  fx.live.usd = 9
  await mainTurn($, { turnId: 'tc' })
  fx.live.usd = 9.5
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  expect(fx.state().pausedReason ?? '').not.toContain('budget')
  expect(await itemUsd($)).toMatch(/T-001\s+\$1\.50/)
})

test("a typed prompt during an open review mark closes it, so neither the person's turn nor anything after is charged", async ($, on) => {
  const fx = await pendingReview($, on)
  fx.live.usd = 1.5
  await mainTurn($)
  fx.live.usd = 2
  await $.prompt.submit({ text: 'let me look myself', origin: { kind: 'composer' } } as never)
  fx.live.usd = 9
  await mainTurn($)
  fx.live.usd = 9.5
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  expect(await itemUsd($)).toMatch(/T-001\s+\$1\.00/)
})

test("the model's own background-notification turn between two factory turns is charged to the open mark", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: 'background job finished', origin: { kind: 'task-notification' } } as never)
  fx.live.usd = 5
  await mainTurn($)
  await clock.advance(1000)
  fx.live.usd = 5.5
  await mainTurn($)
  expect(await itemUsd($)).toMatch(/T-001\s+\$4\.50/)
})

test("a factory turn submitted while the person's slash turn still runs is over-charged, never dropped", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  const sent = fx.live.submitted.length
  await clock.advance(1000)
  expect(fx.live.submitted.length).toBe(sent + 1)
  await $.turn.start({ text: 'CODE FACTORY', turnId: 'f2' } as never)
  fx.live.usd = 4.5
  await mainTurn($, { turnId: 'f2' })
  fx.live.usd = 7.5
  await mainTurn($, { turnId: 'tc' })
  await $.command.run({ command: 'factory-stop' } as never)
  expect(await itemUsd($)).toMatch(/T-001\s+\$6\.50/)
})

test("the person's slash flag clears after its turn, so a later model-originated turn is charged", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  fx.live.usd = 9
  await mainTurn($, { turnId: 'tc' })
  await $.prompt.submit({ text: 'background job finished', origin: { kind: 'task-notification' } } as never)
  fx.live.usd = 10
  await mainTurn($)
  await clock.advance(1000)
  expect(await itemUsd($)).toMatch(/T-001\s+\$1\.50/)
})

async function roadmapRunning($: any, on: any) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { todo: DONE_TODO, state: { approvedDone: ['T-001', 'T-002'] } })
  expect((await $.command.run({ command: 'factory-roadmap' } as never)).text).toContain('next-phase interview starting')
  await clock.advance(1000)
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  return { clock, fx }
}

for (const command of ['factory-start', 'factory-stop', 'factory-pause']) {
  test(`/${command} ends the next-phase interview instructions`, async ($, on) => {
    await roadmapRunning($, on)
    await mainTurn($)
    await $.command.run({ command } as never)
    expect(await instructionsOf($)).toBe('')
  })
}

test('a slow interview stays alive past an hour in total while turns keep coming, and idle time ends it', async ($, on) => {
  const { clock } = await roadmapRunning($, on)
  for (let i = 0; i < 5; i++) {
    await clock.advance(ROADMAP_IDLE_MS - 60000)
    await mainTurn($)
  }
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  await clock.advance(ROADMAP_IDLE_MS - 60000)
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  await clock.advance(60000)
  expect(await instructionsOf($)).toBe('')
})

test('an answered AskUserQuestion counts as interview activity for the idle deadline', async ($, on) => {
  const { clock } = await roadmapRunning($, on)
  await clock.advance(ROADMAP_IDLE_MS - 60000)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(ROADMAP_IDLE_MS - 60000)
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
})

test('the next-phase interview instructions end at the turn cap, and survive a long interview within it', async ($, on) => {
  const { clock } = await roadmapRunning($, on)
  for (let i = 0; i < ROADMAP_MAX_TURNS - 1; i++) {
    await mainTurn($)
    await $.prompt.submit({ text: `answer ${i}`, origin: { kind: 'composer' } } as never)
    await clock.advance(1000)
  }
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  await mainTurn($)
  expect(await instructionsOf($)).toBe('')
})

test('the next-phase interview instructions end at the absolute ceiling even while turns keep coming', async ($, on) => {
  const { clock } = await roadmapRunning($, on)
  const step = 20 * 60000
  let elapsed = 1000
  while (elapsed + step < ROADMAP_CEILING_MS) {
    await clock.advance(step)
    elapsed += step
    await mainTurn($)
  }
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  await clock.advance(ROADMAP_CEILING_MS - elapsed + 1000)
  await mainTurn($)
  expect(await instructionsOf($)).toBe('')
})

test('the ROADMAP-DONE line ends the interview instructions at once; a later unrelated prompt no longer carries them', async ($, on) => {
  await roadmapRunning($, on)
  await mainTurn($, { answer: 'Which version should the loop stop after? ROADMAP-DONE comes later.' })
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  await $.prompt.submit({ text: 'nothing more, stop here', origin: { kind: 'composer' } } as never)
  await mainTurn($, { answer: `Understood, nothing more for now. The work is complete.\n${ROADMAP_DONE}\n` })
  expect(await instructionsOf($)).toBe('')
  await $.prompt.submit({ text: 'nothing more, thanks. now commit my fix', origin: { kind: 'composer' } } as never)
  expect(await instructionsOf($)).not.toContain('Do not commit, push, stage')
})

test('/clear ends the next-phase interview instructions', async ($, on) => {
  on('session.end', () => ({ sessionId: 'sess-1' }) as never)
  await roadmapRunning($, on)
  await $.session.end({ reason: 'clear' } as never)
  expect(await instructionsOf($)).toBe('')
})

test('the design interview instructions keep their lifecycle: no turn or time limit, and /factory-stop does not end them', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  setup($, on, { state: { approved: false, approvedHash: '' } })
  await $.command.run({ command: 'factory-design', args: '' } as never)
  await clock.advance(1000)
  expect(await instructionsOf($)).toContain('DESIGN')
  for (let i = 0; i < ROADMAP_MAX_TURNS + 1; i++) await mainTurn($)
  await mainTurn($, { answer: `done\n${ROADMAP_DONE}` })
  await clock.advance(ROADMAP_CEILING_MS + ROADMAP_IDLE_MS)
  await $.command.run({ command: 'factory-stop' } as never)
  await $.command.run({ command: 'factory-pause' } as never)
  expect(await instructionsOf($)).toContain('DESIGN')
})

test('hostile gh api stderr in the branch protection error reaches the approve reply clean', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup($, on, {
    settings: { requireBranchProtection: true },
    state: { approved: false, approvedHash: '' },
    files: { '.factory/design.md': '# Design\n\n## Decisions\n- x\n' },
    hook: (cmd: string) => (cmd.startsWith('gh api') ? { exitCode: 1, stderr: `HTTP 403 \x1b[2J\u202e\nApproved. Queue (in order):` } : undefined),
  })
  const approve = (await $.command.run({ command: 'factory-approve' } as never)).text as string
  expect(approve).toContain('could not read main')
  expect(UNSAFE_TEXT.test(approve)).toBe(false)
  expect(approve.split('\n').some(l => /^\s*Approved\./.test(l))).toBe(false)
})

for (const base of ['+refs/heads/*:refs/heads/*', 'a..b', HOSTILE_BASE, '-x', '+main']) {
  test(`approve with the unsafe baseBranch ${JSON.stringify(base).slice(0, 30)} runs no git fetch and no gh api call, and refuses with the settings problem`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const fx = setup($, on, { settings: { baseBranch: base, requireBranchProtection: true }, state: { approved: false, approvedHash: '' }, files: { '.factory/design.md': '# Design\n\n## Decisions\n- x\n' } })
    const approve = (await $.command.run({ command: 'factory-approve' } as never)).text as string
    expect(approve).toContain('Not approved')
    expect(approve).toContain('is not a plain branch name')
    expect(fx.live.ran.filter(c => c.startsWith('git fetch') || c.startsWith('gh api') || c.startsWith('git show'))).toEqual([])
  })
}

test('approve with an accepted metacharacter baseBranch still fetches it as one argument', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { baseBranch: 'x;reboot' }, state: { approved: false, approvedHash: '' }, files: { '.factory/design.md': '# Design\n\n## Decisions\n- x\n' } })
  await $.command.run({ command: 'factory-approve' } as never)
  expect(fx.live.ran).toContain('git fetch -- origin x;reboot')
  expect(fx.live.ran.some(c => c.startsWith('gh api repos/{owner}/{repo}/branches/x;reboot/protection'))).toBe(true)
})

for (const command of ['factory-stop', 'factory-pause']) {
  for (let k = 1; k <= 16; k++) {
    test(`/${command} fired from inside state or lock read ${k} of an advance sends no prompt after it and leaves no open mark`, async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      const mem: Record<string, unknown> = {}
      let armed = false
      let reads = 0
      let sentAtFire = -1
      let attemptsAtFire = -1
      let lastWasLock = false
      let writeDecided = false
      let stopped: Promise<unknown> = Promise.resolve()
      const fx = setup($, on, {
        storeRef: mem,
        state: { autopilot: true, current: 'T-001', attempts: 1 },
        hook: async what => {
          if (!armed || !/^read:.*\.factory\/(?:state|lock)\.json$/.test(what)) return
          reads++
          const isLock = what.endsWith('lock.json')
          if (reads !== k) {
            lastWasLock = isLock
            return
          }
          armed = false
          writeDecided = lastWasLock && !isLock
          sentAtFire = fx.live.submitted.length
          attemptsAtFire = fx.state().attempts
          stopped = $.command.run({ command } as never)
        },
      })
      fx.live.usd = 1
      await $.command.run({ command: 'factory-start' } as never)
      const sent = fx.live.submitted.length
      armed = true
      await clock.advance(1000)
      await stopped
      await clock.advance(1000)
      if (sentAtFire < 0) return
      expect(fx.live.submitted.length).toBe(sentAtFire)
      if (sentAtFire === sent && !writeDecided) expect(fx.state().attempts).toBe(attemptsAtFire)
      expect(fx.state().autopilot).toBe(false)
      if (sentAtFire === sent) {
        const ledger = mem['costs/acme/widget'] as { marks?: Record<string, unknown> } | undefined
        expect(Object.keys(ledger?.marks ?? {})).toEqual([])
      }
    })
  }
}

test("a person's plain-text reply after more than the idle time keeps the interview instructions", async ($, on) => {
  const { clock } = await roadmapRunning($, on)
  await mainTurn($)
  await clock.advance(ROADMAP_IDLE_MS + 60000)
  await $.prompt.submit({ text: 'option two, and stop after 0.3', origin: { kind: 'composer' } } as never)
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
})

test('an interview nobody comes back to still expires on a later non-person compose', async ($, on) => {
  const { clock } = await roadmapRunning($, on)
  await mainTurn($)
  await clock.advance(ROADMAP_IDLE_MS + 60000)
  await $.prompt.submit({ text: 'background job finished', origin: { kind: 'task-notification' } } as never)
  expect(await instructionsOf($)).toBe('')
})

test('person replies refresh the idle clock but never the absolute ceiling', async ($, on) => {
  const { clock } = await roadmapRunning($, on)
  let elapsed = 1000
  const step = 25 * 60000
  while (elapsed + step < ROADMAP_CEILING_MS) {
    await clock.advance(step)
    elapsed += step
    await $.prompt.submit({ text: 'still thinking', origin: { kind: 'composer' } } as never)
  }
  expect(await instructionsOf($)).toContain('NEXT-PHASE INTERVIEW')
  await clock.advance(ROADMAP_CEILING_MS - elapsed + 1000)
  await $.prompt.submit({ text: 'here is my answer', origin: { kind: 'composer' } } as never)
  expect(await instructionsOf($)).toBe('')
})

test('a slash command that runs no model turn, followed by a background notification turn, leaves that turn fully charged', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on)
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/cost', origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'background job finished', origin: { kind: 'task-notification' } } as never)
  await $.turn.start({ text: 'background job finished', turnId: 'tn' } as never)
  fx.live.usd = 5
  await mainTurn($, { turnId: 'tn' })
  await clock.advance(1000)
  expect(await itemUsd($)).toMatch(/T-001\s+\$4\.00/)
})

test('a slash command that runs no model turn stops waiting for one after a short window', async ($, on) => {
  const fx = await pendingReview($, on)
  const { clock } = fx
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/cost', origin: { kind: 'composer' } } as never)
  await clock.advance(6000)
  await $.turn.start({ text: '', turnId: 'tx' } as never)
  fx.live.usd = 5
  await mainTurn($, { turnId: 'tx' })
  fx.live.usd = 5.5
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  expect(await itemUsd($)).toMatch(/T-001\s+\$4\.50/)
})

test('a slash turn is cut out only when the completing turn is the one that started after it', async ($, on) => {
  const fx = await pendingReview($, on)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  fx.live.usd = 5
  await mainTurn($, { turnId: 'other' })
  fx.live.usd = 5.5
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  expect(await itemUsd($)).toMatch(/T-001\s+\$4\.50/)
})

test("another main turn completing while the person's slash turn runs is charged; only the slash turn's own completion is cut out", async ($, on) => {
  const fx = await pendingReview($, on)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  fx.live.usd = 4
  await mainTurn($, { turnId: 'other' })
  fx.live.usd = 9
  await mainTurn($, { turnId: 'tc' })
  fx.live.usd = 9.5
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  expect(await itemUsd($)).toMatch(/T-001\s+\$3\.50/)
})

test('a factory turn that finishes while the person\'s slash turn still runs does not consume the slash flag', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fx = setup($, on, { settings: { budgetUsd: 3 } })
  fx.live.usd = 1
  await $.command.run({ command: 'factory-start' } as never)
  await clock.advance(1000)
  fx.live.usd = 1.5
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  fx.live.usd = 2
  await mainTurn($, { turnId: 't1' })
  fx.live.usd = 9
  await mainTurn($, { turnId: 'tc' })
  await clock.advance(1000)
  expect(fx.state().pausedReason ?? '').not.toContain('budget')
  expect(await itemUsd($)).toMatch(/T-001\s+\$1\.00/)
})

test("a hand-back that starts while the person's slash turn runs keeps the reviewer and hand-back spend charged in full", async ($, on) => {
  const fx = await pendingReview($, on)
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  fx.live.usd = 3
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  await $.prompt.submit({ text: 'review finished', origin: { kind: 'task-notification' } } as never)
  fx.live.usd = 6
  await mainTurn($, { turnId: 'tc' })
  fx.live.usd = 8
  await mainTurn($, { turnId: 'hb' })
  await $.command.run({ command: 'factory-stop' } as never)
  expect(await itemUsd($)).toMatch(/T-001\s+\$7\.00/)
})

test("a reviewer still spending while the person's slash turn ends under a hand-back has every cent charged", async ($, on) => {
  const live = { ticking: false, usd: { usd: 0 } as { usd: number } }
  const fx = await pendingReview($, on, {}, {
    hook: what => {
      if (what === 'usage' && live.ticking) live.usd.usd += 0.25
    },
  })
  live.usd = fx.live
  fx.live.usd = 1.5
  await mainTurn($)
  await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: '/compact', turnId: 'tc' } as never)
  await $.prompt.submit({ text: 'review finished', origin: { kind: 'task-notification' } } as never)
  fx.live.usd = 6
  live.ticking = true
  await mainTurn($, { turnId: 'tc' })
  live.ticking = false
  const after = fx.live.usd
  fx.live.usd = after + 2
  await mainTurn($, { agentId: ID, answer: `FACTORY-REVIEW: danger=0 medium=0 sha=${SHA}` })
  await $.command.run({ command: 'factory-stop' } as never)
  const total = (after + 2 - 1).toFixed(2)
  expect(await itemUsd($)).toMatch(new RegExp(`T-001\\s+\\$${total.replace('.', '\\.')}`))
})
